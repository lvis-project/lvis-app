/**
 * The child stubs for the hostApi members that reach a host SERVICE
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * The mirror of `host-api-service-paths.ts`: where the host decodes, this
 * encodes, and where the host encodes, this reconstructs. A plugin holding one
 * of these stubs sees the signature `public-contract.ts` publishes — a real
 * `Response`, a real `SpawnedPluginWorker` handle, a `bearer()` it can call —
 * built out of the JSON that actually crossed.
 *
 * ELECTRON-FREE, and it must be: this runs inside the child. It reaches
 * `capabilities.ts` and `manifest-validation.ts` for the emit check, both of
 * which are pure and Electron-free (verified by import walk), and nothing else
 * host-side.
 *
 * TWO PLACES A CHECK IS DELIBERATELY DUPLICATED, both named where they happen:
 * `emitEvent`'s capability test (to preserve a synchronous throw the wire cannot
 * carry) and `bearer()`-after-`release()` (because the key is a child-local
 * copy). Neither is a substitute for the host's decision; both are re-decided
 * host-side.
 */
import { canEmitEvent } from "../capabilities.js";
import { getDeclaredEmittedEvents } from "../runtime/manifest-validation.js";
import type {
  PluginManifest,
  PluginWorkerSpec,
  SpawnedPluginWorker,
} from "../public-contract.js";
import type { HostApiPath } from "./host-api-path-contracts.js";
import { HostApiBoundaryError, type HostApiHandle } from "./host-api-wire.js";
import {
  asWireWorkerEvent,
  decodeWireHttpResponse,
  encodeWireRequestInit,
  type WireApiKeyLease,
  type WireCallLlmOptions,
  type WireResolveApiKeyOptions,
  type WireWorkerHandle,
} from "./host-api-service-payloads.js";

/** The members this group carries. */
export const SERVICE_HOSTAPI_PATHS = [
  "getSecret",
  "hasRoutineBySource",
  "probePrivateHost",
  "resolveApiKey",
  "emitEvent",
  "logEvent",
  "callLlm",
  "hostFetch",
  "spawnWorker",
] as const satisfies readonly HostApiPath[];

/** One of the nine. */
export type ServiceHostApiPath = (typeof SERVICE_HOSTAPI_PATHS)[number];

/** One hostApi member as the child's stub table holds it. */
export type ChildHostApiMember = (...args: unknown[]) => unknown;

/**
 * What these stubs need from the child runtime.
 *
 * Passed in rather than imported so the runtime owns the ledgers and this module
 * owns only the marshalling — the same split that lets the payload helpers be
 * tested without standing up a runtime.
 */
export interface ServiceChildMemberDeps {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  /** Send one hostApi call and settle it. The runtime's single call path. */
  readonly call: (path: HostApiPath, args: readonly unknown[]) => Promise<unknown>;
  /** Hand over an `AbortSignal`, receive the id that crosses in its place. */
  readonly openAbortChannel: (signal: AbortSignal) => {
    readonly subscriptionId: string;
    readonly release: () => void;
  };
  /**
   * Register a child-side handler under a HOST-allocated id.
   *
   * The four subscription members allocate their own ids, but a `handle` result
   * is named by the host, so the child adopts. Returns the disposer that ends
   * the registration and tells the host.
   */
  readonly adoptSubscription: (
    path: HostApiPath,
    subscriptionId: string,
    handler: (payload: unknown) => void,
    /**
     * Run when the HOST revokes the registration — state the ledger cannot drop
     * on its own, because it lives in the stub's closure rather than in the
     * entry.
     */
    onRevoked?: () => void,
  ) => () => void;
  /**
   * `context.log`, so a failure with no caller left to throw at is still seen.
   *
   * `emitEvent` and `logEvent` return `void`, so a host-side refusal reaches the
   * child after the plugin's call has already returned. Reported through the
   * child's log channel rather than dropped: an unhandled rejection would take
   * the process down, and a swallowed one would make a refused emit look
   * identical to an accepted one.
   */
  readonly report: (message: string, meta?: unknown) => void;
}

/**
 * Drop trailing `undefined` arguments before the call goes on the wire.
 *
 * `f(a)` and `f(a, undefined)` are the same call in JavaScript, and they must
 * stay the same call across the boundary. They do not by default: `undefined`
 * inside an ARRAY is not "absent", it is `null` after `JSON.stringify`, so the
 * host would see an explicit null where the plugin passed nothing — and the
 * dispatcher's JSON gate refuses the array outright rather than let that
 * through. Trimming here is what makes an omitted optional argument omitted.
 */
function positional(...args: unknown[]): readonly unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
}

/** Read a `handle` reply, refusing anything that is not one. */
function requireHandle(value: unknown, path: HostApiPath): HostApiHandle {
  const handle = value as HostApiHandle | null;
  if (handle === null || typeof handle !== "object" || typeof handle.handleId !== "string") {
    throw new HostApiBoundaryError(
      "result-marshalling-rejected",
      `[host-api-service-child] '${path}': reply is not a handle`,
      { path },
    );
  }
  return handle;
}

/**
 * The stubs for this group, keyed by path.
 *
 * Every one of them is `async` where the published signature is async and plain
 * where it is not — `emitEvent` and `logEvent` return `void` synchronously,
 * because that is what the in-process contract promises and a plugin that
 * ignores a returned promise would otherwise never learn it existed.
 */
export function createServiceChildMembers(
  deps: ServiceChildMemberDeps,
): Record<ServiceHostApiPath, ChildHostApiMember> {
  const { call, pluginId } = deps;

  /** One wording for the two members whose failure arrives after they returned. */
  const reportDetached = (path: HostApiPath, error: unknown): void => {
    deps.report(`hostApi.${path} failed after returning`, {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  /** Open an abort channel for an argument that carried a signal. */
  const withAbortChannel = <T>(
    signal: AbortSignal | undefined,
    body: (channelId: string | undefined) => Promise<T>,
  ): Promise<T> => {
    if (!signal) return body(undefined);
    // An ALREADY-aborted signal throws its own reason rather than opening a
    // channel — the in-process call rejects immediately, and a round trip the
    // host would be told to abort on arrival is a slower way to say the same
    // thing. `openAbortChannel` owns that rule.
    const channel = deps.openAbortChannel(signal);
    return body(channel.subscriptionId).finally(channel.release);
  };

  return {
    getSecret: async (...args) =>
      call("getSecret", positional(args[0])) as Promise<string | null>,

    hasRoutineBySource: async (...args) =>
      call("hasRoutineBySource", positional(args[0])) as Promise<boolean>,

    probePrivateHost: async (...args) =>
      call("probePrivateHost", positional(args[0], args[1])) as Promise<boolean>,

    /**
     * Synchronous throw preserved. The host cannot answer in time to make a
     * denied emit throw at the plugin's own call site, so the child re-runs
     * `canEmitEvent` against the manifest it already holds. The host re-decides
     * and writes the denial audit — this check controls TIMING, never access.
     */
    emitEvent: (...args) => {
      const eventType = args[0] as string;
      const declared = getDeclaredEmittedEvents(deps.manifest);
      if (!canEmitEvent(eventType, declared)) {
        throw new Error(
          `Plugin '${pluginId}' is not allowed to emit undeclared event '${String(eventType)}'`,
        );
      }
      call("emitEvent", positional(eventType, args[1])).catch((error: unknown) => {
        reportDetached("emitEvent", error);
      });
    },

    logEvent: (...args) => {
      call("logEvent", positional(args[0], args[1], args[2])).catch((error: unknown) => {
        reportDetached("logEvent", error);
      });
    },

    callLlm: async (...args) => {
      const options = args[1] as { signal?: AbortSignal; maxTokens?: number; systemPrompt?: string } | undefined;
      return withAbortChannel(options?.signal, async (channelId) => {
        const wire: WireCallLlmOptions = {
          ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          ...(options?.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
          ...(channelId !== undefined ? { signalChannelId: channelId } : {}),
        };
        return (await call("callLlm", positional(args[0], wire))) as string;
      });
    },

    /**
     * `input` is flattened to a string because a `URL` is a class instance and
     * would round-trip into something else. The host reads the string exactly as
     * an in-process `fetch` would.
     */
    hostFetch: async (...args) => {
      const input = args[0] as string | URL;
      const init = args[1] as RequestInit | undefined;
      const signal = init?.signal ?? undefined;
      return withAbortChannel(signal ?? undefined, async (channelId) => {
        const wire = encodeWireRequestInit(
          init,
          // The signal was already handed to `withAbortChannel`; this closure
          // only supplies the id it allocated, so one signal never opens two
          // channels. Unreachable when `init.signal` is absent, and loud rather
          // than cast if that ever stops being true.
          () => {
            if (channelId === undefined) {
              throw new HostApiBoundaryError(
                "argument-marshalling-rejected",
                "[host-api-service-child] 'hostFetch': init.signal has no abort channel",
              );
            }
            return channelId;
          },
          "hostFetch(init)",
        );
        const reply = await call("hostFetch", positional(String(input), wire));
        return decodeWireHttpResponse(reply, "hostFetch(result)");
      });
    },

    /**
     * `resolveApiKey` hands back a lease, not a key holder. `bearer()` reads a
     * child-local copy and `release()` drops it AND ends the host registration,
     * so the host can unwire its own — the two-sided lifetime the contract
     * declares.
     */
    resolveApiKey: async (...args) => {
      const opts = args[0] as {
        purpose: WireResolveApiKeyOptions["purpose"];
        vendor?: WireResolveApiKeyOptions["vendor"];
        signal?: AbortSignal;
      };
      return withAbortChannel(opts?.signal, async (channelId) => {
        const wire: WireResolveApiKeyOptions = {
          purpose: opts.purpose,
          ...(opts.vendor !== undefined ? { vendor: opts.vendor } : {}),
          ...(channelId !== undefined ? { signalChannelId: channelId } : {}),
        };
        const lease = requireHandle(
          await call("resolveApiKey", [wire]),
          "resolveApiKey",
        ) as unknown as WireApiKeyLease;
        if (!lease.ok) return { ok: false as const, reason: lease.reason };
        let key: string | undefined = lease.key;
        const dispose = deps.adoptSubscription(
          "resolveApiKey",
          lease.handleId,
          // A lease carries no events. One arriving means the host is pushing
          // on a registration it has nothing to push for, which is reported
          // rather than ignored: silently dropping it would hide a real
          // disagreement about what this member's id means.
          () => {
            deps.report("hostApi.resolveApiKey: the host pushed an event on a lease", {
              handleId: lease.handleId,
            });
          },
          // The host revoked the lease. Drop the child's copy so a later
          // `bearer()` cannot return a credential the host has already unwired.
          // This is the whole reason the credential is held as a mutable
          // closure variable rather than a constant.
          () => {
            key = undefined;
          },
        );
        return {
          ok: true as const,
          vendor: lease.vendor,
          ...(lease.baseUrl !== undefined ? { baseUrl: lease.baseUrl } : {}),
          bearer: () => {
            if (key === undefined) {
              throw new Error(
                `[plugin:${pluginId}] hostApi.resolveApiKey().bearer: lease already released`,
              );
            }
            return key;
          },
          release: () => {
            key = undefined;
            dispose();
          },
        };
      });
    },

    /**
     * The plugin gets a handle whose methods are local: `stop()` ends the
     * registration (the host stops the process it still owns), and the three
     * listener members fan out host pushes. The process itself never crosses,
     * which is the security improvement §3.2 names — in-process the plugin holds
     * a live `ChildProcess`-derived object in the same heap.
     */
    spawnWorker: async (...args) => {
      const spec = args[0] as PluginWorkerSpec;
      const reply = await call("spawnWorker", [spec]);
      const handle = requireHandle(reply, "spawnWorker") as unknown as WireWorkerHandle;
      const stdout: ((chunk: string) => void)[] = [];
      const stderr: ((chunk: string) => void)[] = [];
      const exit: ((info: { code: number | null; signal: NodeJS.Signals | null }) => void)[] = [];
      // The handler closes over `dispose`, which is what this call returns.
      // Safe because a payload can only arrive after `adoptSubscription` has
      // returned — the host does not know the id until the reply reaches it.
      const dispose = deps.adoptSubscription("spawnWorker", handle.handleId, (payload) => {
        const event = asWireWorkerEvent(payload, "spawnWorker(event)");
        if (event.kind === "stdout") {
          for (const listener of stdout) listener(event.chunk);
          return;
        }
        if (event.kind === "stderr") {
          for (const listener of stderr) listener(event.chunk);
          return;
        }
        for (const listener of exit) {
          listener({ code: event.code, signal: event.signal as NodeJS.Signals | null });
        }
        // This side does NOT let go here. The host owns the process, so the
        // host owns the news that it ended: it releases its own registration
        // and the `subscription-closed` that follows drops this one. Disposing
        // here as well would be a second authority for one fact, and it was
        // only ever written because a host-side release could not reach the
        // child — which it now can.
      });
      const worker: SpawnedPluginWorker = {
        socketPath: handle.socketPath,
        pid: handle.pid,
        stop: dispose,
        onStdout: (listener) => void stdout.push(listener),
        onStderr: (listener) => void stderr.push(listener),
        onExit: (listener) => void exit.push(listener),
      };
      return worker;
    },
  };
}
