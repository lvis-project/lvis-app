import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AppServices } from "../boot.js";
import {
  createA2AHttpRouter,
  type A2AHttpRouter,
  type A2ARequestHandler,
} from "../api/a2a-router.js";
import {
  A2ASubAgentHandler,
  type A2AMutationAuthorizer,
  type A2ATaskLifecycleAuditEvent,
} from "../api/a2a-subagent-handler.js";
import {
  A2ATaskStore,
  type A2ATaskStoreAuditEvent,
} from "../api/a2a-task-store.js";
import {
  A2A_PROTOCOL_VERSION,
  type A2AAgentCardTemplate,
} from "../shared/a2a-wire.js";
import { maskSensitiveData } from "../shared/dlp.js";
import {
  isValidA2AWireHostBinding,
  type A2AWireHostBinding,
} from "../engine/subagent-runner.js";
import type { AgentActionApprover } from "../permissions/agent-action-approver.js";
import type { LoadedAgentProfile } from "./agent-profile-store.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";

const HANDLER_ID_DOMAIN = "a2a-loopback-handler-v1\0";
const HANDLER_ID_ALPHABET = "abcdefghjkmnpqrs";
const A2A_TASK_FEATURE = "a2a-loopback";
const MAX_HANDLERS = 32;
const MAX_TASKS_PER_HANDLER = 100;
const MAX_HISTORY_MESSAGES = 64;
const MAX_CARD_DESCRIPTION_CHARS = 512;
const DEFAULT_CARD_DESCRIPTION = "Host-managed local sub-agent profile.";

export interface A2ALoopbackDiscovery {
  protocolVersion: typeof A2A_PROTOCOL_VERSION;
  agentCardPaths: readonly string[];
}

export interface A2ALoopbackRuntime {
  router: A2AHttpRouter;
  discovery: A2ALoopbackDiscovery;
  dispose(): Promise<void>;
}

export interface CreateA2ALoopbackRuntimeOptions {
  services: Pick<
    AppServices,
    "agentProfileStore" | "getSubAgentRunner" | "auditLogger"
  >;
  project: Readonly<{ root: string; name?: string }>;
  appVersion: string;
  approveAgentAction: AgentActionApprover | undefined;
  namespace?: Pick<FeatureNamespaceHandle, "readJson" | "writeJson">;
  deriveHandlerId?: (profile: LoadedAgentProfile) => string;
  /**
   * Optional receiver-only wire decorator. The ph3/local listener omits this
   * hook, so its handlers and gate behavior remain byte-for-byte unchanged.
   */
  transformHandler?: (handler: A2ARequestHandler) => A2ARequestHandler;
}

function canonicalProfilePath(filePath: string, platform: NodeJS.Platform): string {
  const normalized = resolve(filePath).replace(/\\/g, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Stable opaque address derived from host-owned source identity, never display name. */
export function deriveA2ALoopbackHandlerId(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const identity = canonicalProfilePath(filePath, platform);
  const digest = createHash("sha256")
    .update(HANDLER_ID_DOMAIN)
    .update(identity)
    .digest("hex")
    .slice(0, 32)
    .split("")
    .map((nibble) => HANDLER_ID_ALPHABET[Number.parseInt(nibble, 16)])
    .join("");
  return `agent-${digest}`;
}

function cardDescription(profile: LoadedAgentProfile): string {
  const value = profile.description.trim();
  if (
    !value
    || value.length > MAX_CARD_DESCRIPTION_CHARS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    return DEFAULT_CARD_DESCRIPTION;
  }
  const masked = maskSensitiveData(value);
  return masked.detections.length === 0 ? value : DEFAULT_CARD_DESCRIPTION;
}

function buildCard(profile: LoadedAgentProfile, appVersion: string): A2AAgentCardTemplate {
  const maskedName = maskSensitiveData(profile.name);
  if (maskedName.detections.length > 0 || maskedName.masked !== profile.name) {
    throw new Error("a2a-profile-name-rejected");
  }
  const version = appVersion.trim().slice(0, 64) || "0.0.0";
  const card: A2AAgentCardTemplate = {
    name: profile.name,
    description: cardDescription(profile),
    version,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    skills: [
      {
        id: "delegate-work",
        name: "Delegate work",
        description: "Run a bounded task with this host-managed sub-agent profile.",
        tags: ["delegation"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
      },
    ],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: {
      bearerAuth: {
        httpAuthSecurityScheme: {
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "Per-boot local capability token.",
        },
      },
    },
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
  };
  Object.freeze(card.capabilities);
  for (const skill of card.skills) {
    Object.freeze(skill.tags);
    Object.freeze(skill.inputModes);
    Object.freeze(skill.outputModes);
    Object.freeze(skill);
  }
  Object.freeze(card.skills);
  Object.freeze(card.defaultInputModes);
  Object.freeze(card.defaultOutputModes);
  Object.freeze(card.securitySchemes?.bearerAuth.httpAuthSecurityScheme);
  Object.freeze(card.securitySchemes?.bearerAuth);
  Object.freeze(card.securitySchemes);
  Object.freeze(card.securityRequirements?.[0]?.schemes.bearerAuth.list);
  Object.freeze(card.securityRequirements?.[0]?.schemes.bearerAuth);
  Object.freeze(card.securityRequirements?.[0]?.schemes);
  Object.freeze(card.securityRequirements?.[0]);
  Object.freeze(card.securityRequirements);
  return Object.freeze(card);
}

function buildBinding(
  handlerId: string,
  profile: LoadedAgentProfile,
  project: Readonly<{ root: string; name?: string }>,
): A2AWireHostBinding {
  const projectName = project.name?.trim();
  const safeProjectName = projectName
    && projectName.length <= 120
    && maskSensitiveData(projectName).detections.length === 0
    ? projectName
    : undefined;
  const binding: A2AWireHostBinding = Object.freeze({
    handlerId,
    profile: Object.freeze({
      name: profile.name,
      body: profile.body,
      sourceTools: Object.freeze([...profile.sourceTools]),
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.mode ? { mode: profile.mode } : {}),
    }),
    project: Object.freeze({
      root: project.root,
      ...(safeProjectName ? { name: safeProjectName } : {}),
    }),
  });
  if (!isValidA2AWireHostBinding(binding)) {
    throw new Error("a2a-profile-binding-rejected");
  }
  return binding;
}

function writeAudit(
  services: CreateA2ALoopbackRuntimeOptions["services"],
  input: string,
): void {
  try {
    services.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "a2a-loopback",
      type: "warn",
      input,
    });
  } catch {
    // Audit failure must not alter the fail-closed wire decision.
  }
}

export async function createA2ALoopbackRuntime(
  options: CreateA2ALoopbackRuntimeOptions,
): Promise<A2ALoopbackRuntime | null> {
  const profileStore = options.services.agentProfileStore;
  const runner = options.services.getSubAgentRunner?.();
  if (!profileStore || !runner) throw new Error("a2a-runtime-unavailable");

  const profiles = await profileStore.list();
  if (profiles.length === 0) return null;
  if (profiles.length > MAX_HANDLERS) throw new Error("a2a-handler-capacity-exceeded");

  const deriveId = options.deriveHandlerId
    ?? ((profile: LoadedAgentProfile) => deriveA2ALoopbackHandlerId(profile.filePath));
  const snapshots = profiles.map((profile) => ({
    profile,
    handlerId: deriveId(profile),
  }));
  const handlerIds = new Set(snapshots.map(({ handlerId }) => handlerId));
  if (handlerIds.size !== snapshots.length) throw new Error("a2a-handler-id-collision");

  const store = new A2ATaskStore({
    namespace: options.namespace ?? openFeatureNamespace(A2A_TASK_FEATURE),
    maxTasks: MAX_HANDLERS * MAX_TASKS_PER_HANDLER,
    maxTasksPerHandler: MAX_TASKS_PER_HANDLER,
    maxHistoryMessages: MAX_HISTORY_MESSAGES,
    activeHandlerIds: handlerIds,
    audit: (event: A2ATaskStoreAuditEvent) => {
      writeAudit(options.services, `a2a:task-store:${event.reason}:${event.count}`);
    },
  });

  const authorizeMutation: A2AMutationAuthorizer = async (descriptor) => {
    if (!options.approveAgentAction) return false;
    return Boolean(await options.approveAgentAction({
      toolName: `a2a-${descriptor.operation}`,
      args: { operation: descriptor.operation, handlerId: descriptor.handlerId },
      reason: "An external A2A client requested a sub-agent mutation. Do you want to allow it?",
      trustOrigin: "a2a-loopback",
    }));
  };

  const handlers = snapshots.map(({ profile, handlerId }) => {
    const audit = (event: A2ATaskLifecycleAuditEvent): void => {
      writeAudit(
        options.services,
        `a2a:task-lifecycle:${event.outcome}:${event.reason}:${handlerId}`,
      );
    };
    return new A2ASubAgentHandler({
      id: handlerId,
      card: buildCard(profile, options.appVersion),
      binding: buildBinding(handlerId, profile, options.project),
      runner,
      store,
      authorizeMutation,
      audit,
    });
  });
  const wireHandlers = options.transformHandler
    ? handlers.map((handler) => options.transformHandler!(handler))
    : handlers;
  const router = createA2AHttpRouter({
    handlers: wireHandlers,
    audit: (event) => writeAudit(options.services, `a2a:wire:${event.reason}`),
  });
  try {
    await Promise.all(handlers.map((handler) => handler.startInputRequiredExpiry()));
  } catch (error) {
    await Promise.allSettled(handlers.map((handler) => handler.dispose()));
    throw error;
  }
  const agentCardPaths = Object.freeze(
    router.handlerIds.map((id) => `/a2a/${id}/.well-known/agent-card.json`),
  );
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    router,
    discovery: Object.freeze({
      protocolVersion: A2A_PROTOCOL_VERSION,
      agentCardPaths,
    }),
    dispose(): Promise<void> {
      if (!disposePromise) {
        disposePromise = Promise.all(handlers.map((handler) => handler.dispose()))
          .then(() => undefined);
      }
      return disposePromise;
    },
  });
}
