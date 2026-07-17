import { createHash } from "node:crypto";
import {
  A2AHandlerError,
  A2AWireResponseError,
  type A2ARequestHandler,
  type A2AWireHandlerResult,
  type A2AWireRequestContext,
} from "./a2a-router.js";
import { A2AExactReplayStore, type A2AReplayBeginResult } from "./a2a-exact-replay-store.js";
import {
  A2A_ERROR_INFO_TYPE,
  A2AHostJsonRpcErrorDefinition,
  A2AJsonRpcErrorDefinition,
  A2AJsonRpcMethod,
  type A2AAgentCardTemplate,
  type A2ADirectJsonRpcMethod,
  type A2ADirectJsonRpcResult,
  type A2AJsonObject,
  type A2AJsonRpcRequest,
  type A2ASendMessageResult,
} from "../shared/a2a-wire.js";
import {
  A2A_EXACT_SEND_REPLAY_ERROR_NAMESPACE,
  A2A_EXACT_SEND_REPLAY_URI,
} from "./a2a-remote-contracts.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_EXTENSION_HEADER_BYTES = 2_048;
const MAX_EXTENSION_ENTRIES = 8;

const EXACT_REPLAY_ERRORS = {
  conflict: [-32090, "Exact send replay conflict", "EXACT_SEND_REPLAY_CONFLICT"],
  expired: [-32091, "Exact send replay retention expired", "EXACT_SEND_REPLAY_RETENTION_EXPIRED"],
  progress: [-32092, "Exact send replay in progress", "EXACT_SEND_REPLAY_IN_PROGRESS"],
  unknown: [-32093, "Exact send replay outcome unknown", "EXACT_SEND_REPLAY_OUTCOME_UNKNOWN"],
  capacity: [-32094, "Exact send replay capacity exhausted", "EXACT_SEND_REPLAY_CAPACITY_EXHAUSTED"],
} as const;

export interface A2ARemoteCallerAuthenticator {
  authenticate(authorization: string | undefined): Promise<Readonly<{
    callerGenerationId: string;
  }> | null>;
}

export interface CreateA2AExactReplayHandlerOptions {
  enabled: boolean;
  handler: A2ARequestHandler;
  store: A2AExactReplayStore;
  authenticator: A2ARemoteCallerAuthenticator;
  specificationDigestSha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactReplayError(kind: keyof typeof EXACT_REPLAY_ERRORS): A2AWireResponseError {
  const [code, message, reason] = EXACT_REPLAY_ERRORS[kind];
  const inProgress = kind === "progress";
  return new A2AWireResponseError(
    200,
    {
      code,
      message,
      data: [{
        "@type": A2A_ERROR_INFO_TYPE,
        reason,
        domain: A2A_EXACT_SEND_REPLAY_ERROR_NAMESPACE,
        ...(inProgress ? { metadata: { retryAfterSeconds: "1" } } : {}),
      }],
    },
    {
      "A2A-Extensions": A2A_EXACT_SEND_REPLAY_URI,
      ...(inProgress ? { "Retry-After": "1" } : {}),
    },
  );
}

function authenticationFailure(): A2AWireResponseError {
  return new A2AWireResponseError(401, {
    code: -32000,
    message: "Authentication required",
  }, { "WWW-Authenticate": "Bearer" });
}

function extensionRequired(): A2AWireResponseError {
  const definition = A2AJsonRpcErrorDefinition.EXTENSION_SUPPORT_REQUIRED;
  return new A2AWireResponseError(200, {
    code: definition.code,
    message: definition.message,
    data: [{
      "@type": A2A_ERROR_INFO_TYPE,
      reason: definition.reason,
      domain: "a2a-protocol.org",
    }],
  });
}

function parseExtensions(value: A2AWireRequestContext["extensions"]): Readonly<{
  exact: boolean;
  unknownRequired: boolean;
}> {
  if (value === undefined) return { exact: false, unknownRequired: false };
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > MAX_EXTENSION_HEADER_BYTES) {
    throw extensionRequired();
  }
  const entries = value.split(",");
  if (entries.length > MAX_EXTENSION_ENTRIES || entries.join(",") !== value) throw extensionRequired();
  const seen = new Set<string>();
  let exact = false;
  let unknownRequired = false;
  for (const entry of entries) {
    const required = entry.endsWith(";required");
    const uri = required ? entry.slice(0, -9) : entry;
    if (!uri || uri.length > 512 || seen.has(uri)) throw extensionRequired();
    if (uri !== A2A_EXACT_SEND_REPLAY_URI) {
      try {
        const parsed = new URL(uri);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.toString() !== uri) throw new Error();
      } catch { throw extensionRequired(); }
    }
    seen.add(uri);
    if (uri === A2A_EXACT_SEND_REPLAY_URI) {
      // This profile is advertised optional. A caller may activate only the
      // exact URI token; rewriting `;required` into the optional token would
      // silently change negotiation semantics.
      if (required) throw extensionRequired();
      exact = true;
    }
    else if (required) unknownRequired = true;
  }
  return { exact, unknownRequired };
}

function initialMessageIdentity(params: A2AJsonObject): { messageId: string; intentSha256: string } | null {
  if (!isRecord(params.message) || typeof params.message.messageId !== "string") return null;
  if (params.message.taskId !== undefined) return null;
  if (!isRecord(params.metadata)) return null;
  const extension = params.metadata[A2A_EXACT_SEND_REPLAY_URI];
  if (!isRecord(extension) || Object.keys(extension).length !== 1 || !SHA256.test(String(extension.intentSha256))) {
    return null;
  }
  return { messageId: params.message.messageId, intentSha256: String(extension.intentSha256) };
}

function sendResult(value: A2ADirectJsonRpcResult): A2ASendMessageResult {
  if (!isRecord(value)) throw new Error("a2a-exact-replay-result-invalid");
  const keys = Object.keys(value);
  if (keys.length !== 1 || (keys[0] !== "message" && keys[0] !== "task")) {
    throw new Error("a2a-exact-replay-result-invalid");
  }
  return structuredClone(value as A2ASendMessageResult);
}

function replayOutcome(result: A2AReplayBeginResult): never | A2ASendMessageResult | string {
  switch (result.kind) {
    case "completed": return result.result;
    case "conflict": throw exactReplayError("conflict");
    case "retention-expired": throw exactReplayError("expired");
    case "in-progress": throw exactReplayError("progress");
    case "outcome-unknown": throw exactReplayError("unknown");
    case "capacity-exhausted": throw exactReplayError("capacity");
    case "owner": return result.ownerToken;
  }
}

function buildCard(base: A2AAgentCardTemplate, digest: string): A2AAgentCardTemplate {
  if (!SHA256.test(digest)) throw new Error("a2a-exact-replay-spec-digest-invalid");
  const existing = base.capabilities.extensions ?? [];
  if (existing.some((extension) => extension.uri === A2A_EXACT_SEND_REPLAY_URI)) {
    throw new Error("a2a-exact-replay-extension-duplicate");
  }
  const card: A2AAgentCardTemplate = {
    ...structuredClone(base),
    capabilities: {
      ...structuredClone(base.capabilities),
      extensions: [
        ...structuredClone(existing),
        Object.freeze({
          uri: A2A_EXACT_SEND_REPLAY_URI,
          description: "Durable exact replay for ambiguous non-streaming SendMessage responses.",
          required: false,
          params: Object.freeze({
            profile: "lvis-exact-send-replay",
            profileVersion: "1",
            requestBody: "exact-serialized-jsonrpc",
            resultRetentionSeconds: "604800",
            specDigestSha256: digest,
          }),
        }),
      ],
    },
  };
  return Object.freeze(card);
}

export class A2AExactReplayHandler implements A2ARequestHandler {
  readonly id: string;
  readonly card: A2AAgentCardTemplate;

  constructor(private readonly options: CreateA2AExactReplayHandlerOptions) {
    if (!options.enabled) throw new Error("a2a-remote-receiver-disabled");
    this.id = options.handler.id;
    this.card = buildCard(options.handler.card, options.specificationDigestSha256);
  }

  async handle(
    _method: A2ADirectJsonRpcMethod,
    _params: A2AJsonObject,
  ): Promise<A2ADirectJsonRpcResult> {
    throw new A2AHandlerError(A2AHostJsonRpcErrorDefinition.OPERATION_REJECTED);
  }

  async handleWire(
    request: Readonly<A2AJsonRpcRequest>,
    context: Readonly<A2AWireRequestContext>,
  ): Promise<A2AWireHandlerResult> {
    const caller = await this.options.authenticator.authenticate(context.authorization);
    if (!caller) throw authenticationFailure();
    const extensions = parseExtensions(context.extensions);
    if (extensions.unknownRequired) throw extensionRequired();
    const params = request.params ?? {};
    const identity = request.method === A2AJsonRpcMethod.SEND_MESSAGE
      ? initialMessageIdentity(params)
      : null;
    if (identity) {
      if (!extensions.exact) throw extensionRequired();
      const begun = await this.options.store.begin({
        callerGenerationId: caller.callerGenerationId,
        messageId: identity.messageId,
        bodySha256: createHash("sha256").update(context.rawBody).digest("hex"),
        intentSha256: identity.intentSha256,
      });
      const outcome = replayOutcome(begun);
      if (typeof outcome !== "string") {
        return { result: outcome, headers: { "A2A-Extensions": A2A_EXACT_SEND_REPLAY_URI } };
      }
      let result: A2ASendMessageResult;
      try {
        result = sendResult(await this.options.handler.handle(
          request.method as A2ADirectJsonRpcMethod,
          params,
        ));
      } catch {
        await this.options.store.markOutcomeUnknown(outcome);
        throw exactReplayError("unknown");
      }
      if (!(await this.options.store.complete(outcome, result))) throw exactReplayError("expired");
      return { result, headers: { "A2A-Extensions": A2A_EXACT_SEND_REPLAY_URI } };
    }
    if (extensions.exact || (isRecord(params.metadata) && A2A_EXACT_SEND_REPLAY_URI in params.metadata)) {
      throw extensionRequired();
    }
    return {
      result: await this.options.handler.handle(
        request.method as A2ADirectJsonRpcMethod,
        params,
      ),
    };
  }
}

export function createA2AExactReplayHandler(
  options: CreateA2AExactReplayHandlerOptions,
): A2ARequestHandler {
  return options.enabled ? new A2AExactReplayHandler(options) : options.handler;
}
