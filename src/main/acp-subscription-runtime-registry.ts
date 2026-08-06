/**
 * Main-owned registry for the small, static set of supported ACP subscription
 * runtimes. Renderer input selects only an allowlisted id; it never controls a
 * command, arguments, environment, runtime home, or working directory.
 */
import { join } from "node:path";
import type { StreamEvent } from "../engine/llm/types.js";
import type { SubscriptionPromptAttachment } from "./subscription-attachment-input.js";
import {
  ACP_SUBSCRIPTION_PROVIDER_IDS,
  type AcpSubscriptionProviderId,
  type AcpSubscriptionStatus,
} from "../shared/acp-subscription.js";
import {
  acpSubscriptionRuntimeDirectoryNames,
  ensureAcpSubscriptionNativePolicy,
  AcpSubscriptionRuntimeConfigStore,
  type AcpSubscriptionMcpServerConfig,
  validateAcpSubscriptionMcpServerConfigs,
} from "./acp-subscription-runtime-config.js";
import {
  AcpSubscriptionRuntimeClient,
  AcpSubscriptionRuntimeError,
} from "./acp-subscription-runtime-client.js";
import {
  AcpSubscriptionSessionClient,
  type AcpSubscriptionHostRequestObservation,
  type AcpSubscriptionPromptHandle,
  type AcpSubscriptionSessionClientOptions,
} from "./acp-subscription-session-client.js";
import {
  openFeatureNamespace,
  type FeatureNamespaceHandle,
} from "./storage/feature-namespace.js";

type ClientMap = Record<AcpSubscriptionProviderId, AcpSubscriptionRuntimeClient>;

export interface AcpSubscriptionTextSession {
  readonly provider: AcpSubscriptionProviderId;
  streamTurn(
    text: string,
    abortSignal?: AbortSignal,
    attachments?: readonly SubscriptionPromptAttachment[],
  ): AsyncIterable<StreamEvent>;
  cancelActiveTurn(): Promise<void>;
  stop(): Promise<void>;
}

export interface AcpSubscriptionTextSessionOptions {
  readonly onHostRequest?: (
    request: AcpSubscriptionHostRequestObservation,
  ) => void | Promise<void>;
  /**
   * The one main-process-created LVIS MCP bridge for this session. It is
   * runtime-validated and copied before the session factory receives it.
   */
  readonly mcpServers?: readonly AcpSubscriptionMcpServerConfig[];
}

export interface AcpSubscriptionSessionTransport {
  start(): Promise<unknown>;
  startPrompt(input: {
    readonly text: string;
    readonly abortSignal?: AbortSignal;
    readonly attachments?: readonly SubscriptionPromptAttachment[];
  }): Promise<AcpSubscriptionPromptHandle>;
  cancelActivePrompt(): Promise<void>;
  stop(): Promise<void>;
}

export type AcpSubscriptionSessionClientFactory = (
  options: AcpSubscriptionSessionClientOptions,
) => AcpSubscriptionSessionTransport;

interface ResolvedAcpSubscriptionRuntimeRegistryOptions {
  readonly namespace: FeatureNamespaceHandle;
  readonly configStore: AcpSubscriptionRuntimeConfigStore;
  readonly clients: ClientMap;
  readonly sessionClientFactory: AcpSubscriptionSessionClientFactory;
}

export interface AcpSubscriptionRuntimeRegistryOptions {
  namespace?: FeatureNamespaceHandle;
  configStore?: AcpSubscriptionRuntimeConfigStore;
  clients?: ClientMap;
  sessionClientFactory?: AcpSubscriptionSessionClientFactory;
}

export class AcpSubscriptionRuntimeRegistry {
  private readonly namespace: FeatureNamespaceHandle;
  private readonly configStore: AcpSubscriptionRuntimeConfigStore;
  private readonly clients: ClientMap;
  private readonly sessionClientFactory: AcpSubscriptionSessionClientFactory;
  private readonly textSessions = new Set<AcpSubscriptionSessionTransport>();

  private constructor(options: ResolvedAcpSubscriptionRuntimeRegistryOptions) {
    this.namespace = options.namespace;
    this.configStore = options.configStore;
    this.clients = options.clients;
    this.sessionClientFactory = options.sessionClientFactory;
  }

  static async create(
    options: AcpSubscriptionRuntimeRegistryOptions = {},
  ): Promise<AcpSubscriptionRuntimeRegistry> {
    const namespace = options.namespace ?? openFeatureNamespace("subscription-runtimes");
    const configStore = options.configStore ?? new AcpSubscriptionRuntimeConfigStore(namespace);
    const sessionClientFactory: AcpSubscriptionSessionClientFactory = options.sessionClientFactory
      ?? ((sessionOptions) => new AcpSubscriptionSessionClient(sessionOptions));
    if (options.clients) {
      return new AcpSubscriptionRuntimeRegistry({
        namespace,
        configStore,
        clients: options.clients,
        sessionClientFactory,
      });
    }
    const executablePaths = await Promise.all(
      ACP_SUBSCRIPTION_PROVIDER_IDS.map((provider) => configStore.getExecutable(provider)),
    );
    const clients = {} as ClientMap;
    for (const [index, provider] of ACP_SUBSCRIPTION_PROVIDER_IDS.entries()) {
      const directories = acpSubscriptionRuntimeDirectoryNames(provider);
      clients[provider] = new AcpSubscriptionRuntimeClient({
        provider,
        runtimeHome: join(namespace.dir, directories.runtimeHome),
        workspaceDir: join(namespace.dir, directories.workspaceDir),
        runtimeTempDir: join(namespace.dir, directories.runtimeTempDir),
        executablePath: executablePaths[index] ?? null,
      });
    }
    return new AcpSubscriptionRuntimeRegistry({
      namespace,
      configStore,
      clients,
      sessionClientFactory,
    });
  }

  async getStatus(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].getStatus();
  }

  async setExecutable(provider: AcpSubscriptionProviderId, pickerPath: string): Promise<AcpSubscriptionStatus> {
    const client = this.clients[provider];
    const previous = client.getConfiguredExecutable();
    const status = await client.setExecutable(pickerPath);
    const canonicalPath = client.getConfiguredExecutable();
    if (!canonicalPath) throw new Error("acp-subscription-missing-canonical-executable");
    try {
      await this.configStore.setExecutable(provider, canonicalPath);
    } catch (error) {
      if (previous) {
        await client.setExecutable(previous);
      } else {
        await client.clearExecutable();
      }
      throw error;
    }
    return status;
  }

  async forgetExecutable(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    const client = this.clients[provider];
    const previous = client.getConfiguredExecutable();
    const status = await client.clearExecutable();
    try {
      await this.configStore.clearExecutable(provider);
    } catch (error) {
      if (previous) await client.setExecutable(previous);
      throw error;
    }
    return status;
  }

  /**
   * Start one authenticated ACP conversation with at most the one supplied
   * LVIS-owned MCP server. The returned object
   * remains main-process-only: opaque session identifiers, raw protocol data,
   * and runtime capabilities never cross this registry boundary.
   */
  async openTextSession(
    provider: AcpSubscriptionProviderId,
    options: AcpSubscriptionTextSessionOptions = {},
  ): Promise<AcpSubscriptionTextSession> {
    const mcpServers = validateAcpSubscriptionMcpServerConfigs(options.mcpServers);
    const directories = await this.prepareRuntime(provider);
    const executablePath = this.clients[provider].getConfiguredExecutable();
    if (!executablePath) throw new AcpSubscriptionRuntimeError("acp-runtime-not-configured");

    const session = this.sessionClientFactory({
      provider,
      executablePath,
      runtimeHome: directories.runtimeHome,
      workspaceDir: directories.workspaceDir,
      runtimeTempDir: directories.runtimeTempDir,
      onHostRequest: options.onHostRequest,
      mcpServers,
    });
    this.textSessions.add(session);
    try {
      await session.start();
    } catch (error) {
      this.textSessions.delete(session);
      try {
        await session.stop();
      } catch {
        // Preserve the stable session start failure rather than a cleanup error.
      }
      throw error;
    }

    let stopped = false;
    return Object.freeze({
      provider,
      async *streamTurn(
        text: string,
        abortSignal?: AbortSignal,
        attachments?: readonly SubscriptionPromptAttachment[],
      ): AsyncIterable<StreamEvent> {
        const prompt = await session.startPrompt({ text, abortSignal, attachments });
        for await (const event of prompt.events) yield event;
        await prompt.completion;
      },
      cancelActiveTurn: () => session.cancelActivePrompt(),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.textSessions.delete(session);
        await session.stop();
      },
    });
  }

  async verify(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].verify();
  }

  async startDeviceCodeLogin(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].startDeviceCodeLogin();
  }

  async openPendingVerificationUrl(
    provider: AcpSubscriptionProviderId,
    openExternal: (url: string) => Promise<void>,
  ): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].openPendingVerificationUrl(openExternal);
  }

  async cancelLogin(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    return this.clients[provider].cancelLogin();
  }

  async logout(provider: AcpSubscriptionProviderId): Promise<AcpSubscriptionStatus> {
    await this.prepareRuntime(provider);
    return this.clients[provider].logout();
  }

  async stopAll(): Promise<void> {
    const textSessions = [...this.textSessions];
    this.textSessions.clear();
    await Promise.all([
      ...textSessions.map((session) => session.stop()),
      ...ACP_SUBSCRIPTION_PROVIDER_IDS.map((provider) => this.clients[provider].stop()),
    ]);
  }

  private async prepareRuntime(provider: AcpSubscriptionProviderId): Promise<{
    readonly runtimeHome: string;
    readonly workspaceDir: string;
    readonly runtimeTempDir: string;
  }> {
    const directoryNames = acpSubscriptionRuntimeDirectoryNames(provider);
    const [runtimeHome, workspaceDir, runtimeTempDir] = await Promise.all([
      this.namespace.childDir(directoryNames.runtimeHome),
      this.namespace.childDir(directoryNames.workspaceDir),
      this.namespace.childDir(directoryNames.runtimeTempDir),
    ]);
    await ensureAcpSubscriptionNativePolicy(provider, runtimeHome);
    return Object.freeze({ runtimeHome, workspaceDir, runtimeTempDir });
  }
}
