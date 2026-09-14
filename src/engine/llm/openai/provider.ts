import type { SubscriptionChatRuntimeSelection } from "../../../shared/subscription-runtime.js";
import type {
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
} from "../types.js";
import { projectOpenAiMessages, projectOpenAiTools } from "./request.js";
import { estimateRequestInputProjection } from "../../request-input-projection.js";

type OpenAiTransport = Pick<LLMProvider, "streamTurn" | "projectRequestInput">;

export type OpenAiProviderConnection =
  | {
      /** API credentials and request-owned reasoning/output options remain in the transport. */
      kind: "api-key";
      transport: OpenAiTransport;
    }
  | {
      /** Native reasoning stays profile-owned; thinking hints remain prompt content only. */
      kind: "codex-subscription";
      selection: SubscriptionChatRuntimeSelection & { provider: "codex" };
      transport: OpenAiTransport;
    };

/** Shared request policy with separately owned authentication and wire protocols. */
export class OpenAiProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly subscriptionRuntime?: SubscriptionChatRuntimeSelection;
  private readonly transport: OpenAiTransport;
  private readonly connectionKind: OpenAiProviderConnection["kind"];

  constructor(connection: OpenAiProviderConnection) {
    this.transport = connection.transport;
    this.connectionKind = connection.kind;
    if (connection.kind === "codex-subscription") {
      if (connection.selection.kind !== "subscription" || connection.selection.provider !== "codex") {
        throw new Error("invalid OpenAI subscription connection");
      }
      this.subscriptionRuntime = Object.freeze({
        kind: "subscription",
        provider: "codex",
        ...(connection.selection.model === undefined ? {} : { model: connection.selection.model }),
      });
    }
  }

  projectRequestInput(
    input: ProviderRequestInputProjectionParams,
  ): ProviderRequestInputProjection | undefined {
    const projected = {
      ...input,
      messages: projectOpenAiMessages(input.messages),
      toolSchemas: projectOpenAiTools(input.toolSchemas),
    };
    // The API keeps the engine's existing estimator, applied to the same
    // prepared input as dispatch. Native envelopes retain their own estimator.
    return this.connectionKind === "api-key"
      ? estimateRequestInputProjection(projected, {
          vendor: this.vendor,
          projectRequestInput: this.transport.projectRequestInput?.bind(this.transport),
        })
      : this.transport.projectRequestInput?.(projected);
  }

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    // Keep the selected model, output controls and signal exact. The connection
    // owns their native meaning and the provenance of every returned event.
    yield* this.transport.streamTurn({
      ...params,
      messages: projectOpenAiMessages(params.messages),
      ...(params.tools === undefined ? {} : { tools: projectOpenAiTools(params.tools) }),
    });
  }
}

export function createOpenAiProvider(connection: OpenAiProviderConnection): OpenAiProvider {
  return new OpenAiProvider(connection);
}
