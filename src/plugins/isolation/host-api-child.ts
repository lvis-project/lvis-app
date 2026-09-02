/**
 * The CHILD half of every hostApi member the boundary carries
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2, §3.4).
 *
 * One module because it is one stub table. `plugin-child-runtime.ts` builds a
 * single `Record<HostApiPath, ChildHostApiMember>` and the four groups here are
 * spread into it at one site; none of them is reachable from anywhere else, and
 * splitting them by category only bought four copies of the same relay guard.
 * The mirror of `host-api-dispatcher.ts`: where the host decodes, this encodes,
 * and where the host encodes, this reconstructs. A plugin holding one of these
 * stubs sees the signature `public-contract.ts` publishes — a real `Response`, a
 * real `SpawnedPluginWorker` handle, a `bearer()` it can call — built out of the
 * JSON that actually crossed.
 *
 * THREE STUBS DO SOMETHING; THE REST RELAY. `storage.read` decodes a tagged byte
 * payload, `storage.write` encodes one, `storage.resolve` never leaves — and
 * every other storage or interaction member sends its arguments as they are and
 * hands back what the host answered. That split is DERIVED from the contract SOT
 * rather than assumed: {@link assertRelayable} refuses to build a relaying stub
 * for a path whose contract says something else, so a member that later grows an
 * `encoded` axis cannot silently keep crossing through a relay that does no
 * encoding.
 *
 * WHY THE HOST'S ANSWERS ARE NOT RE-CHECKED. The threat model runs one way —
 * the host does not trust the child — and a plugin that cannot trust its own
 * host has already lost. So a member whose contract says `plain-json` takes the
 * reply as the type the contract declares, and a host-side argument rule is
 * never mirrored here: a child-side copy would be a second, weaker copy of a
 * security rule sitting in the least-trusted process, which is a place a plugin
 * can edit.
 *
 * TWO PLACES A CHECK IS DELIBERATELY DUPLICATED, both named where they happen:
 * `emitEvent`'s capability test (to preserve a synchronous throw the wire cannot
 * carry) and `bearer()`-after-`release()` (because the key is a child-local
 * copy). Neither is a substitute for the host's decision; both are re-decided
 * host-side.
 *
 * TRAILING OPTIONALS ARE OMITTED, NOT SENT AS `undefined`. `describeNonJson`
 * refuses `undefined` INSIDE an array — there it does not mean absent, it
 * becomes `null` — and `args` is an array. A stub that forwarded its own
 * unsupplied parameter would turn `readText(path)` into a rejected call.
 *
 * ELECTRON-FREE, and it must be: this runs inside the child, which is a plain
 * Node process. It reaches `capabilities.ts`, `manifest-validation.ts` and
 * `plugin-storage-containment.ts`, all of which are pure and Electron-free
 * (verified by import walk), and nothing else host-side.
 */
import { canEmitEvent } from "../capabilities.js";
import { getDeclaredEmittedEvents } from "../runtime/manifest-validation.js";
import { resolvePluginStoragePath } from "../plugin-storage-containment.js";
import type {
  AuthPartitionCookie,
  PluginManifest,
  PluginWorkerSpec,
  SpawnedPluginWorker,
  AudioCaptureDevice,
  AudioCaptureEnd,
  AudioCaptureFrame,
  AttachFloatingPanelRequest,
  AudioCaptureHandle,
  DetachReason,
  FloatingPanelHandle,
  AudioCaptureRequest,
  WorkProposalResult,
} from "../public-contract.js";
import type { HostApiCaller, PluginChildContext } from "./plugin-child-runtime.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  HostApiBoundaryError,
  INTERACTION_HOSTAPI_PATHS,
  SECRET_REDACTED_SENTINEL,
  STORAGE_HOSTAPI_PATHS,
  asWireWorkerEvent,
  decodeConfigChange,
  decodeHostEvent,
  decodePluginLifecycle,
  decodeWireBinary,
  decodeWireHttpResponse,
  encodeWireBytes,
  encodeWireRequestInit,
  type ConfigSubscriptionPath,
  type HostApiHandle,
  type HostApiPath,
  type InteractionHostApiPath,
  type ServiceHostApiPath,
  type StorageHostApiPath,
  type WireApiKeyLease,
  type WireCallLlmOptions,
  type WireResolveApiKeyOptions,
  type WireWorkerHandle,
  asWireAudioCaptureEvent,
  asWireFloatingPanelEvent,
  type WireFloatingPanelHandle,
  type WireAudioCaptureHandle,
} from "./host-api-wire.js";
import { errorMessage } from "../../shared/error-message.js";

/** One hostApi member as the child's stub table holds it. */
export type ChildHostApiMember = (...args: unknown[]) => unknown;

/**
 * Refuse to relay a member whose contract does not say "send it as it is".
 *
 * Fail-closed at stub construction rather than at the call: a path that gains
 * an `encoded` axis would otherwise keep crossing through a relay that does no
 * encoding, and the symptom would be a wrong value rather than a failure.
 */
function assertRelayable(path: HostApiPath): void {
  const contract = HOSTAPI_PATH_CONTRACTS[path];
  if (
    contract.arguments !== "plain-json"
    || (contract.result !== "plain-json" && contract.result !== "void")
    || contract.lifetime !== "none"
  ) {
    throw new Error(
      `[host-api-child] '${path}' no longer crosses as plain JSON `
        + `(arguments=${contract.arguments} result=${contract.result} `
        + `lifetime=${contract.lifetime}) — it needs a stub of its own`,
    );
  }
}


// ─────────────────────────────────────────────────────────────────────────
// Interaction members: what puts something in front of the user (§3.4)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build this group's child-side stubs.
 *
 * Every stub goes through {@link HostApiCaller}, which is the one place the
 * envelope is stamped and the one place a reply's error identity is rebuilt.
 * A stub that assembled its own request would be a second place the generation
 * is claimed, and the generation is what the host checks the call against.
 */
export function createInteractionChildMembers(
  call: HostApiCaller,
): Record<InteractionHostApiPath, (...args: unknown[]) => Promise<unknown>> {
  const members = {} as Record<
    InteractionHostApiPath,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const path of INTERACTION_HOSTAPI_PATHS) {
    assertRelayable(path);
    members[path] = (...args: unknown[]) => call(path, args);
  }
  return members;
}

// ─────────────────────────────────────────────────────────────────────────
// Service members: what reaches a host service (§3.1, §3.2)
// ─────────────────────────────────────────────────────────────────────────

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
      `[host-api-child] '${path}': reply is not a handle`,
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
      error: errorMessage(error),
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

    getAuthPartitionCookies: async (...args) =>
      call("getAuthPartitionCookies", positional(args[0])) as Promise<
        Array<{ url: string; cookies: AuthPartitionCookie[] }>
      >,

    hasRoutineBySource: async (...args) =>
      call("hasRoutineBySource", positional(args[0])) as Promise<boolean>,

    // Unlike `emitEvent`, no local pre-check: `proposeWork` is Promise-returning,
    // so the host's refusal arrives at the plugin's own await. Re-deriving the
    // granted kinds here would be a second copy of the authorization rule with
    // nothing to gain — the host is already the one that answers.
    proposeWork: async (...args) =>
      call("proposeWork", positional(args[0])) as Promise<WorkProposalResult>,

    withdrawWorkProposal: async (...args) =>
      call("withdrawWorkProposal", positional(args[0], args[1])) as Promise<boolean>,

    probePrivateHost: async (...args) =>
      call("probePrivateHost", positional(args[0], args[1])) as Promise<boolean>,

    resolveMappedDriveRoot: async (...args) =>
      call("resolveMappedDriveRoot", positional(args[0])) as Promise<string | null>,

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
                "[host-api-child] 'hostFetch': init.signal has no abort channel",
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
    listAudioInputDevices: async () =>
      call("listAudioInputDevices", positional()) as Promise<readonly AudioCaptureDevice[]>,
    /**
     * The capture handle, rebuilt on this side from a host-allocated id.
     *
     * Frames arrive as host notifications and are fanned out to child-local
     * listeners here — the listener functions themselves never cross, which is
     * the same property that makes `spawnWorker`'s `onStdout` safe.
     */
    startAudioCapture: async (...args) => {
      const request = args[0] as AudioCaptureRequest;
      const reply = await call("startAudioCapture", [request]);
      const handle = requireHandle(reply, "startAudioCapture") as unknown as WireAudioCaptureHandle;
      const frames: ((frame: AudioCaptureFrame) => void)[] = [];
      const ends: ((end: AudioCaptureEnd) => void)[] = [];
      const dispose = deps.adoptSubscription("startAudioCapture", handle.handleId, (payload) => {
        const event = asWireAudioCaptureEvent(payload, "startAudioCapture(event)");
        if (event.kind === "frame") {
          // Decoded once, here, and handed to every listener: decoding per
          // listener would copy a frame of audio for each one.
          const pcm = new Uint8Array(Buffer.from(event.pcm, "base64"));
          for (const listener of frames) listener({ seq: event.seq, pcm, peak: event.peak });
          return;
        }
        for (const listener of ends) {
          listener({
            reason: event.reason as AudioCaptureEnd["reason"],
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          });
        }
        // Not disposed here, for the reason spelled out on `spawnWorker`: the
        // host owns the capture, so the host owns the news that it ended.
      });
      const capture: AudioCaptureHandle = {
        captureId: handle.captureId,
        opened: handle.opened,
        onFrame: (listener) => {
          frames.push(listener);
          return () => {
            const at = frames.indexOf(listener);
            if (at >= 0) frames.splice(at, 1);
          };
        },
        onEnd: (listener) => {
          ends.push(listener);
          return () => {
            const at = ends.indexOf(listener);
            if (at >= 0) ends.splice(at, 1);
          };
        },
        stop: async () => { dispose(); },
      };
      return capture;
    },
    /**
     * The dock slot, rebuilt on this side.
     *
     * `detach()` is the SUBSCRIPTION's dispose, not a call: the wire carries
     * calls by path and a handle is a host-side object this side holds a
     * receipt for, so releasing the receipt is what "detach" means across the
     * boundary. `resize` is the opposite case — it needs an answer back, so it
     * goes out as its own addressable path carrying the panel id.
     */
    attachFloatingPanel: async (...args) => {
      const request = args[0] as AttachFloatingPanelRequest;
      const reply = await call("attachFloatingPanel", [request]);
      const handle = requireHandle(reply, "attachFloatingPanel") as unknown as WireFloatingPanelHandle;
      const listeners: ((reason: DetachReason) => void)[] = [];
      let height = handle.height;
      // The REASON, not a flag. A late subscriber has to be told the same
      // thing an early one was, and a boolean cannot carry it — see
      // `onDetached` below for what inventing one costs.
      let detachedAs: DetachReason | null = null;
      const dispose = deps.adoptSubscription("attachFloatingPanel", handle.handleId, (payload) => {
        const event = asWireFloatingPanelEvent(payload, "attachFloatingPanel(event)");
        if (detachedAs) return;
        detachedAs = event.reason as DetachReason;
        for (const listener of listeners) listener(detachedAs);
        listeners.length = 0;
        // Not disposed here, for the reason spelled out on `spawnWorker`: the
        // host owns the slot, so the host owns the news that it closed.
      });
      const panel: FloatingPanelHandle = {
        panelId: handle.panelId,
        get height() {
          return height;
        },
        resize: async (next: number) => {
          height = Number(await call("resizeFloatingPanel", [handle.panelId, next]));
          return height;
        },
        detach: async () => {
          dispose();
        },
        onDetached: (listener) => {
          if (detachedAs) {
            // Late subscriber on a slot that is already gone. Silence would
            // leave it waiting for an event that has already happened — and
            // answering with a GUESS is worse than silence.
            //
            // This used to say `"requested"` unconditionally while holding the
            // real reason one closure away. The window is narrow (a plugin
            // subscribes in the same turn the attach resolves in) but it is
            // real, and `"requested"` is the one value that means "the plugin
            // asked for this". A recorder that hears it after the USER closed
            // the dock concludes the teardown was its own and leaves the
            // recording running with nothing on screen driving it, which is
            // the exact failure the reason exists to prevent.
            listener(detachedAs);
            return;
          }
          listeners.push(listener);
        },
      };
      return panel;
    },
    resizeFloatingPanel: async (...args) =>
      call("resizeFloatingPanel", [String(args[0]), Number(args[1])]),
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

// ─────────────────────────────────────────────────────────────────────────
// Storage members: `hostApi.storage.*` (§3.1, §3.2)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The three members whose stub is not a plain relay: two carry an `encoded`
 * axis and one never crosses at all.
 */
const NON_RELAYED_STORAGE_PATHS: readonly StorageHostApiPath[] = [
  "storage.resolve",
  "storage.read",
  "storage.write",
];

/**
 * Drop trailing `undefined`s so an unsupplied optional argument crosses as
 * absent rather than as a rejected array element. Interior `undefined`s are
 * left alone: a caller that skipped a middle argument means `null`, and
 * silently shortening the list would shift every argument after it.
 */
function withoutTrailingAbsent(args: readonly unknown[]): unknown[] {
  const wire = [...args];
  while (wire.length > 0 && wire[wire.length - 1] === undefined) wire.pop();
  return wire;
}

/**
 * `data` for `storage.write`. Refused here, at the plugin's own call site, so
 * the failure carries the plugin's stack rather than arriving as a dispatcher
 * rejection whose stack points at the transport.
 */
function requireBytesOrText(pluginId: string, value: unknown): string | Uint8Array {
  if (typeof value === "string" || value instanceof Uint8Array) return value;
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[plugin-child:${pluginId}] hostApi.storage.write: data must be a string or Uint8Array`,
  );
}

/**
 * Build this group's child-side stubs.
 *
 * Every stub that crosses goes through {@link HostApiCaller}, which is the one
 * place the envelope is stamped and the one place a reply's error identity is
 * rebuilt. A stub that assembled its own request would be a second place the
 * generation is claimed, and the generation is what the host checks the call
 * against.
 */
export function createStorageChildMembers(
  call: HostApiCaller,
  context: Pick<PluginChildContext, "pluginId" | "pluginDataDir">,
): Record<StorageHostApiPath, ChildHostApiMember> {
  const { pluginId, pluginDataDir } = context;
  for (const path of STORAGE_HOSTAPI_PATHS) {
    if (NON_RELAYED_STORAGE_PATHS.includes(path)) continue;
    assertRelayable(path);
  }
  return {
    "storage.resolve": (...segments) =>
      resolvePluginStoragePath(pluginId, pluginDataDir, segments),

    // The one reply that is not JSON. `decodeWireBinary` also refuses a
    // utf8-tagged payload, so a host that answered with text instead of bytes
    // is a loud failure rather than a `Uint8Array`-shaped string.
    "storage.read": async (relPath) =>
      decodeWireBinary(await call("storage.read", [relPath]), "storage.read(result)"),

    "storage.readText": async (relPath, encoding) =>
      (await call(
        "storage.readText",
        withoutTrailingAbsent([relPath, encoding]),
      )) as string,

    "storage.readJson": (relPath) => call("storage.readJson", [relPath]),

    "storage.list": async (relPath) =>
      (await call("storage.list", withoutTrailingAbsent([relPath]))) as string[],

    "storage.exists": async (relPath) =>
      (await call("storage.exists", [relPath])) as boolean,

    // The one argument list that is not JSON. The tag is what stops a base64
    // string the plugin meant verbatim from being written decoded.
    "storage.write": async (relPath, data, encoding) => {
      const bytes = encodeWireBytes(
        requireBytesOrText(pluginId, data),
        "storage.write(data)",
      );
      await call("storage.write", withoutTrailingAbsent([relPath, bytes, encoding]));
    },

    "storage.writeJson": async (relPath, value, indent) => {
      await call(
        "storage.writeJson",
        withoutTrailingAbsent([relPath, value, indent]),
      );
    },

    "storage.rm": async (relPath, removeOptions) => {
      await call("storage.rm", withoutTrailingAbsent([relPath, removeOptions]));
    },

    "storage.mkdir": async (relPath) => {
      await call("storage.mkdir", [relPath]);
    },

    "storage.writeEncrypted": async (relPath, plaintext) => {
      await call("storage.writeEncrypted", [relPath, plaintext]);
    },

    "storage.readEncrypted": async (relPath) =>
      (await call("storage.readEncrypted", [relPath])) as string,
  };
}

/**
 * The CHILD half of the config members and the four subscription members
 * (`docs/blueprints/plugin-process-isolation.md` §3.1).
 *
 * WHAT A `handler-registration` MEMBER ACTUALLY DOES. The plugin passes a
 * function; a function cannot cross. The child registers it locally under an id
 * IT allocates, sends the id, and hands the plugin back a disposer that closes
 * the LOCAL registration. The id is child-allocated rather than host-allocated
 * because the handler has to be reachable before the first event can arrive: a
 * child that waited for the reply to learn its id would have a window in which
 * an event has nowhere to go.
 *
 * WHY THE SUBSCRIBE REQUEST IS NOT AWAITED. All four members return
 * synchronously in the in-process contract — three a disposer, `onShutdown`
 * nothing — and a process boundary is not synchronous. Returning a Promise
 * would be a contract change for every plugin. So the local registration is the
 * synchronous part and the round trip runs behind it; a subscribe that FAILS is
 * reported through the log channel and the local registration is dropped, never
 * left half-open pretending to be subscribed.
 *
 * The payload codecs this group decodes with live in `host-api-wire.ts`, beside
 * the encoders the host dispatches through, so the two halves of one payload
 * cannot drift.
 */

/** One child-side registration, as `plugin-child-runtime.ts` hands it back. */
interface ChildSubscriptionHandle {
  readonly subscriptionId: string;
  readonly dispose: () => void;
}

/** What the child runtime lends this group so it does not re-derive any of it. */
export interface ConfigSubscriptionChildDeps {
  readonly pluginId: string;
  /** The one place the envelope is stamped and the call id allocated. */
  readonly call: HostApiCaller;
  /** The one child-side subscription ledger, shared with every other member. */
  readonly openSubscription: (
    path: HostApiPath,
    handler: (payload: unknown) => void,
  ) => ChildSubscriptionHandle;
  /**
   * The child's copy of the resolved config, seeded from the construction push.
   *
   * MUTABLE and shared with `config.set`, which writes into it only after the
   * host has confirmed the write. That is what makes a plugin's own
   * set-then-get see its own value: `set` is awaited, and the snapshot is
   * current by the time it resolves.
   */
  readonly config: Record<string, unknown>;
  /** `context.log`, so an async failure with no caller to throw to is still seen. */
  readonly report: (message: string, meta?: unknown) => void;
}

/**
 * Reject a member argument the plugin got wrong, at the plugin's own call site.
 *
 * These are plugin bugs, not wire failures, and the in-process version answers
 * several of them with a silent `undefined` — `config.get(42)` reads as "unset"
 * rather than "you passed a number". A member that cannot tell those apart is a
 * member whose answer cannot be trusted, so this throws instead.
 */
function requireStringArgument(
  pluginId: string,
  member: string,
  name: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `[plugin-child:${pluginId}] hostApi.${member}: '${name}' must be a string`,
    );
  }
  return value;
}

function requireFunctionArgument(
  pluginId: string,
  member: string,
  name: string,
  value: unknown,
): (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new TypeError(
      `[plugin-child:${pluginId}] hostApi.${member}: '${name}' must be a function`,
    );
  }
  return value as (...args: unknown[]) => unknown;
}

/**
 * Open a subscription: register locally, then ask the host to wire its side.
 *
 * The round trip is deliberately not awaited (see the group's header). What it
 * MUST not do is fail silently — a plugin holding a disposer for a
 * subscription the host never opened would receive nothing and have no way to
 * find out, which is the same symptom as a working subscription for an event
 * that never fires.
 */
function subscribe(
  deps: ConfigSubscriptionChildDeps,
  path: HostApiPath,
  args: (subscriptionId: string) => readonly unknown[],
  handler: (payload: unknown) => void,
): ChildSubscriptionHandle {
  const subscription = deps.openSubscription(path, handler);
  void deps.call(path, args(subscription.subscriptionId)).catch((error: unknown) => {
    deps.report(`hostApi.${path}: the host refused the subscription`, {
      subscriptionId: subscription.subscriptionId,
      error: errorMessage(error),
    });
    // Drop the local half too. Keeping it would leave the plugin holding a
    // disposer for a registration that exists on neither side.
    subscription.dispose();
  });
  return subscription;
}

/**
 * The six members, wired to the boundary.
 *
 * Returned as a partial map rather than installed directly so
 * `plugin-child-runtime.ts` composes the groups in one place — four authors
 * adding four spreads, instead of four authors editing one switch.
 */
export function createConfigSubscriptionChildMembers(
  deps: ConfigSubscriptionChildDeps,
): Record<ConfigSubscriptionPath, ChildHostApiMember> {
  const { pluginId } = deps;
  return {
    // No round trip: the resolved config was pushed at construction and the
    // child reads its own copy. `config.get` is synchronous in the contract and
    // a process boundary is not, so this is the member the design answers by
    // never sending it — the dispatcher refuses it if it ever arrives.
    "config.get": (...args) =>
      deps.config[requireStringArgument(pluginId, "config.get", "key", args[0])],

    "config.set": async (...args) => {
      const key = requireStringArgument(pluginId, "config.set", "key", args[0]);
      const value = args[1];
      await deps.call("config.set", [key, value]);
      // Only AFTER the host confirms. Writing the snapshot optimistically would
      // make a rejected write (a `format: "secret"` key, an inactive
      // incarnation) readable through `config.get` as though it had persisted.
      deps.config[key] = value;
    },

    "config.onChange": (...args) => {
      const key = requireStringArgument(pluginId, "config.onChange", "key", args[0]);
      const callback = requireFunctionArgument(
        pluginId,
        "config.onChange",
        "callback",
        args[1],
      );
      const subscription = subscribe(
        deps,
        "config.onChange",
        (subscriptionId) => [key, subscriptionId],
        (payload) => {
          const change = decodeConfigChange(payload);
          // The snapshot moves BEFORE the callback runs, so a callback that
          // reads `config.get(key)` sees the value it was just handed rather
          // than the one it replaced.
          if (change.value === SECRET_REDACTED_SENTINEL) {
            // The sentinel is NOT a config value and must never enter the
            // snapshot. A secret lives in the keychain and is stripped out of
            // the cleartext `pluginConfigs` record the host resolves, so the
            // in-process `config.get` answers `undefined` for a secret key —
            // and the secret-set path deletes any stray cleartext copy. Storing
            // the sentinel here would make `config.get` hand the plugin a
            // Symbol that no in-process plugin can ever see.
            delete deps.config[change.key];
          } else {
            deps.config[change.key] = change.value;
          }
          callback(change.value);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    onEvent: (...args) => {
      const eventType = requireStringArgument(pluginId, "onEvent", "eventType", args[0]);
      const handler = requireFunctionArgument(pluginId, "onEvent", "handler", args[1]);
      const subscription = subscribe(
        deps,
        "onEvent",
        (subscriptionId) => [eventType, subscriptionId],
        (payload) => {
          handler(decodeHostEvent(payload).data);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    onPluginsChanged: (...args) => {
      const handler = requireFunctionArgument(
        pluginId,
        "onPluginsChanged",
        "handler",
        args[0],
      );
      const subscription = subscribe(
        deps,
        "onPluginsChanged",
        (subscriptionId) => [subscriptionId],
        (payload) => {
          handler(decodePluginLifecycle(payload).event);
        },
      );
      return () => {
        subscription.dispose();
      };
    },

    // The odd one of the four: it returns NOTHING, because the host ends it
    // (`lifetime: "host-terminated"`). The child still holds a ledger entry so
    // the registration dies with the host rather than outliving it, but the
    // plugin is given no disposer — matching the in-process signature exactly.
    onShutdown: (...args) => {
      const handler = requireFunctionArgument(pluginId, "onShutdown", "handler", args[0]);
      const subscription: ChildSubscriptionHandle = subscribe(
        deps,
        "onShutdown",
        (subscriptionId) => [subscriptionId],
        () => {
          void (async () => {
            try {
              await handler();
            } catch (error) {
              deps.report("hostApi.onShutdown: the plugin's handler threw", {
                error: errorMessage(error),
              });
            } finally {
              // The release is how the host learns the handler has finished —
              // it is the reply to a fire-and-forget notification. It runs even
              // when the handler threw, because a host that waits forever for a
              // plugin that has already failed is the hang this replaces.
              subscription.dispose();
            }
          })();
        },
      );
      return undefined;
    },
  };
}
