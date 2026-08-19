/**
 * The entrypoint of a confined plugin child process
 * (`docs/blueprints/plugin-process-isolation.md` §5.2).
 *
 * This module IS the child's `main`. It is spawned by
 * `out-of-process-plugin.ts` through the ASRT wrapper, speaks the multiplexed
 * framed protocol on stdin/stdout, and hands everything above the transport to
 * `startPluginChildRuntime`.
 *
 * ELECTRON-FREE, and enforced by the import graph rather than promised: every
 * module reachable from here is free of `electron`, which is why
 * `buildImportUrl` had to move out of `runtime/sandbox.ts` (that file reaches
 * `electron`'s `safeStorage` through `plugins/storage.ts`) and into
 * `runtime/plugin-loader.ts`. The child therefore obtains its factory from the
 * SAME `importPluginFactory` the in-process loader uses — not a second copy of
 * it that could pick a different export.
 *
 * STDOUT IS THE PROTOCOL. A plugin that calls `console.log` or writes to
 * `process.stdout` directly would interleave unframed bytes into the stream and
 * desynchronise the host's decoder — a failure that looks like a corrupt plugin
 * rather than a stray log line, because the decoder resynchronises by
 * discarding and so eats the frame the log line landed in. Before any plugin
 * code can run, stdout is taken away from it: the real write is captured
 * privately for the framer and everything else is rebound to stderr, which the
 * host pipes and reads as diagnostics.
 */
import { PassThrough, Writable } from "node:stream";
import { Console } from "node:console";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importPluginFactory } from "../runtime/plugin-loader.js";
import { frameMessage } from "../../mcp/stdio-framing.js";
import {
  startPluginChildRuntime,
  type PluginChildRuntime,
} from "./plugin-child-runtime.js";
import {
  classifyMultiplexedMessage,
  FramedMessageStream,
  PendingCallTable,
  type MultiplexedMessage,
} from "./child-stream-multiplex.js";
import {
  PLUGIN_INSTANCE_METHODS,
  PLUGIN_INSTANCE_WIRE_VERSION,
  type PluginConstructParams,
  type PluginConstructResult,
  type PluginLifecycleHookName,
  type ReadUiResourceParams,
  type ReadUiResourceResult,
} from "./plugin-instance-wire.js";
import type {
  HostApiChannel,
  HostApiNotification,
  HostApiReply,
  HostApiRequest,
} from "./host-api-wire.js";
import {
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
} from "../../mcp/protocol-constants.js";

/** JSON-RPC internal error, the code `StdioServerLoop` uses for a throwing handler. */
const RPC_INTERNAL_ERROR = -32603;

/** What {@link servePluginChild} hands back so a caller can end it. */
export interface PluginChildService {
  /** The host's pipes closed: release both sides and settle everything pending. */
  hostGone(): void;
}

/**
 * Take stdout away from everything except the framer, and return the stream the
 * protocol writes to.
 */
function claimProtocolStdout(): Writable {
  const rawWrite = process.stdout.write.bind(process.stdout);
  const divert = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === "function" ? encoding : callback;
    process.stderr.write(chunk as string | Uint8Array);
    if (typeof done === "function") (done as () => void)();
    return true;
  };
  process.stdout.write = divert as typeof process.stdout.write;
  // `console.log` captured `process.stdout` when `node:console` was first
  // loaded, so rebinding the method alone leaves it writing to the old
  // reference. The global console is rebuilt onto stderr instead.
  globalThis.console = new Console(process.stderr, process.stderr);
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      rawWrite(chunk);
      callback();
    },
  });
}

/** Which optional lifecycle hooks an instance actually implements. */
function describeLifecycleHooks(instance: PluginChildRuntime["instance"]): PluginLifecycleHookName[] {
  const hooks: PluginLifecycleHookName[] = [];
  if (typeof instance.start === "function") hooks.push("start");
  if (typeof instance.onPublished === "function") hooks.push("onPublished");
  if (typeof instance.stop === "function") hooks.push("stop");
  return hooks;
}

/**
 * Serve one plugin over the given streams.
 *
 * Exported and stream-injected so the whole child can be driven over in-memory
 * paired streams, exactly as `stdio-server-loop`'s own tests drive the serving
 * core — spawning a subprocess to assert a routing decision would make the
 * cheapest tests the slowest ones. The production entry below supplies the real
 * pipes.
 */
export function servePluginChild(
  input: NodeJS.ReadableStream,
  output: Writable,
): PluginChildService {
  let runtime: PluginChildRuntime | undefined;
  const hostApiReplies = new PendingCallTable<HostApiReply>();
  // The MCP server writes whole frames into this and they are forwarded
  // verbatim — nothing re-decodes them, so a forwarded chunk is always exactly
  // one frame and can never split around another writer's.
  const mcpOut = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output.write(chunk);
      callback();
    },
  });
  // What `StdioServerLoop` reads. Only MCP requests are written into it: the
  // five lifecycle methods and the entire hostApi direction never reach it.
  const mcpIn = new PassThrough();

  const stream = new FramedMessageStream(input as never, output, (message) =>
    route(message),
  );

  const channel: HostApiChannel = {
    call(request: HostApiRequest): Promise<HostApiReply> {
      stream.send(request);
      // No deadline: a hostApi call may legitimately block on a human at the
      // approval gate (§7.5). It rejects when the host is gone, which is the
      // condition a deadline here would only be standing in for.
      return hostApiReplies.register(request.callId, undefined, () => undefined);
    },
    notify(notification: HostApiNotification): void {
      stream.send(notification);
    },
  };

  function reply(id: unknown, result: unknown): void {
    stream.send({ jsonrpc: "2.0", id, result });
  }

  function replyError(id: unknown, code: number, message: string): void {
    stream.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function construct(
    params: PluginConstructParams,
  ): Promise<PluginConstructResult> {
    if (runtime) throw new Error("[plugin-child] already constructed");
    if (params.wire !== PLUGIN_INSTANCE_WIRE_VERSION) {
      throw new Error(
        `[plugin-child] instance wire ${String(params.wire)} != ${PLUGIN_INSTANCE_WIRE_VERSION}`,
      );
    }
    runtime = await startPluginChildRuntime({
      input: mcpIn,
      output: mcpOut,
      manifest: params.manifest,
      context: params.context,
      channel,
      loadFactory: () => importPluginFactory(params.entryPath),
    });
    const { instance } = runtime;
    return {
      wire: PLUGIN_INSTANCE_WIRE_VERSION,
      // Filtered from the HOST's declared set rather than enumerated from the
      // instance: a child cannot announce a tool its manifest never declared,
      // which is the same set `buildMethodMap` derives in-process.
      implementedToolNames: params.declaredToolNames.filter(
        (name) => typeof instance.handlers[name] === "function",
      ),
      servesUiResources: typeof instance.readUiResource === "function",
      lifecycleHooks: describeLifecycleHooks(instance),
    };
  }

  async function invokeInstanceMethod(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (method === PLUGIN_INSTANCE_METHODS.construct) {
      return await construct(params as unknown as PluginConstructParams);
    }
    if (!runtime) throw new Error(`[plugin-child] '${method}' before construct`);
    const { instance } = runtime;
    switch (method) {
      case PLUGIN_INSTANCE_METHODS.start:
        await instance.start?.();
        return null;
      case PLUGIN_INSTANCE_METHODS.onPublished:
        await instance.onPublished?.();
        return null;
      case PLUGIN_INSTANCE_METHODS.stop:
        await instance.stop?.();
        return null;
      case PLUGIN_INSTANCE_METHODS.readUiResource: {
        const uri = (params as unknown as ReadUiResourceParams | undefined)?.uri;
        if (typeof uri !== "string") {
          throw new Error("[plugin-child] readUiResource requires a string 'uri'");
        }
        if (typeof instance.readUiResource !== "function") {
          throw new Error("[plugin-child] this plugin serves no ui resources");
        }
        const html = await instance.readUiResource(uri);
        return { html } satisfies ReadUiResourceResult;
      }
      default:
        throw new Error(`[plugin-child] unknown instance method '${method}'`);
    }
  }

  function route(message: MultiplexedMessage): void {
    switch (classifyMultiplexedMessage(message)) {
      case "instance-request": {
        const { id } = message;
        if (id === undefined) return;
        void invokeInstanceMethod(
          message.method as string,
          message.params as Record<string, unknown> | undefined,
        ).then(
          (result) => reply(id, result),
          (error: unknown) =>
            replyError(
              id,
              RPC_INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            ),
        );
        return;
      }
      case "mcp-request": {
        if (!runtime) {
          // Refused rather than queued: a queued call would be answered by an
          // instance the host had not yet been told exists.
          if (message.id !== undefined) {
            replyError(
              message.id,
              RPC_METHOD_NOT_FOUND,
              "[plugin-child] the plugin is not constructed yet",
            );
          }
          return;
        }
        mcpIn.write(frameMessage(message));
        return;
      }
      case "host-api-reply":
        hostApiReplies.settle(
          message.callId as string,
          message as unknown as HostApiReply,
        );
        return;
      case "host-api-notification":
        runtime?.deliver(message as unknown as HostApiNotification);
        return;
      case "host-api-request":
        // The child never services hostApi calls. A host that sent one is
        // confused, and answering would put a second implementation of the
        // reverse channel in the least trustworthy process.
        replyError(
          message.callId,
          RPC_INVALID_PARAMS,
          "[plugin-child] not a hostApi server",
        );
        return;
      default:
        // Dropped. A frame matching no shape is not guessed at.
        return;
    }
  }

  stream.start();

  return {
    hostGone(): void {
      hostApiReplies.rejectAll("[plugin-child] the host is gone");
      runtime?.hostGone();
    },
  };
}

/**
 * Whether this module is what the process was launched to run.
 *
 * Compared as REAL paths on both sides: Node resolves symlinks when it derives
 * `import.meta.url` for the main module, so comparing it against a raw
 * `process.argv[1]` would answer "no" for a correct launch through any
 * symlinked directory — `/tmp` on macOS being the one every developer hits.
 */
function isProcessEntryModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return realpathSync.native(entry) === fileURLToPath(import.meta.url);
}

/**
 * The production entry: real pipes, and exit when the host closes them.
 *
 * Guarded so importing this file from a test does not hijack the test runner's
 * stdio.
 */
if (isProcessEntryModule()) {
  const service = servePluginChild(process.stdin, claimProtocolStdout());
  const end = (): void => {
    service.hostGone();
    // The host owns this process's lifetime. Once its pipes are closed there is
    // no one left to serve, and a child that lingered would be a confined
    // process running plugin code nothing is watching.
    process.exit(0);
  };
  process.stdin.on("end", end);
  process.stdin.on("close", end);
}
