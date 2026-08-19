/**
 * The plugin end of `hostApi.storage.*`: what the stub inside a child process
 * does with each of the twelve members
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * Eleven are a round trip. The twelfth, `storage.resolve`, is answered HERE and
 * never sent — it is a pure lexical join under `pluginDataDir`, it returns
 * `string` rather than a promise, and a process boundary cannot be synchronous.
 * `plugin-storage-containment.ts` is the module the host's own guard uses, so
 * the child's answer and the host's enforcement cannot drift apart.
 *
 * WHAT THIS FILE DOES NOT DO: re-check the host's answers. The threat model
 * runs one way — the host does not trust the child — and a plugin that cannot
 * trust its own host has already lost. So a member whose contract says
 * `plain-json` takes the reply as the type the contract declares, and the only
 * member that transforms a reply is `storage.read`, whose bytes genuinely are
 * not JSON and have to be decoded. Adding assertions to the other ten would be
 * ten more copies of a shape check that guards nothing.
 *
 * TRAILING OPTIONALS ARE OMITTED, NOT SENT AS `undefined`. `describeNonJson`
 * refuses `undefined` INSIDE an array — there it does not mean absent, it
 * becomes `null` — and `args` is an array. A stub that forwarded its own
 * unsupplied parameter would turn `readText(path)` into a rejected call.
 */
import { resolvePluginStoragePath } from "../plugin-storage-containment.js";
import type { HostApiPath } from "./host-api-path-contracts.js";
import type { HostApiCaller } from "./plugin-child-runtime.js";
import {
  HostApiBoundaryError,
  decodeWireBinary,
  encodeWireBytes,
} from "./host-api-wire.js";

/** One member of the child's hostApi stub, before `PluginHostApi` narrows it. */
export type ChildHostApiMember = (...args: unknown[]) => unknown;

export interface ChildStorageMembersOptions {
  readonly pluginId: string;
  /** The plugin's data root, as the host sent it at construction. */
  readonly pluginDataDir: string;
  /** The shared caller — the only place the envelope is stamped. */
  readonly call: HostApiCaller;
}

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

/** The `storage.*` half of the child's hostApi stub. */
export function createChildStorageMembers(
  options: ChildStorageMembersOptions,
): Partial<Record<HostApiPath, ChildHostApiMember>> {
  const { pluginId, pluginDataDir, call } = options;
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
