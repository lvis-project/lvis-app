/**
 * The child's half of `hostApi.storage.*`
 * (`docs/blueprints/plugin-process-isolation.md` §3.1, §3.2).
 *
 * Twelve members, eleven of them a round trip. The twelfth, `storage.resolve`,
 * is answered HERE and never sent: it is a pure lexical join under
 * `pluginDataDir`, it returns `string` rather than a promise, and a process
 * boundary cannot be synchronous. `plugin-storage-containment.ts` is the module
 * the host's own guard uses, so the child's answer and the host's enforcement
 * cannot drift apart.
 *
 * THREE STUBS DO SOMETHING; THE REST RELAY. `read` decodes a tagged byte
 * payload, `write` encodes one, `resolve` never leaves — and every other member
 * sends its arguments as they are and hands back what the host answered. That
 * split is DERIVED from the contract SOT rather than assumed:
 * {@link assertRelayable} refuses to build a relaying stub for a path whose
 * contract says something else, so a member that later grows an `encoded` axis
 * cannot silently keep crossing through a relay that does no encoding.
 *
 * WHY THE HOST'S ANSWERS ARE NOT RE-CHECKED. The threat model runs one way —
 * the host does not trust the child — and a plugin that cannot trust its own
 * host has already lost. So a member whose contract says `plain-json` takes the
 * reply as the type the contract declares. The only reply that is transformed
 * is `storage.read`'s, whose bytes genuinely are not JSON.
 *
 * TRAILING OPTIONALS ARE OMITTED, NOT SENT AS `undefined`. `describeNonJson`
 * refuses `undefined` INSIDE an array — there it does not mean absent, it
 * becomes `null` — and `args` is an array. A stub that forwarded its own
 * unsupplied parameter would turn `readText(path)` into a rejected call.
 *
 * ELECTRON-FREE. Imported by the child, which is a plain Node process.
 */
import { resolvePluginStoragePath } from "../plugin-storage-containment.js";
import {
  HOSTAPI_PATH_CONTRACTS,
  type HostApiPath,
} from "./host-api-path-contracts.js";
import type { HostApiCaller, PluginChildContext } from "./plugin-child-runtime.js";
import {
  HostApiBoundaryError,
  decodeWireBinary,
  encodeWireBytes,
} from "./host-api-wire.js";

/** The members this group carries. */
export const STORAGE_HOSTAPI_PATHS = [
  "storage.resolve",
  "storage.read",
  "storage.readText",
  "storage.readJson",
  "storage.list",
  "storage.exists",
  "storage.write",
  "storage.writeJson",
  "storage.rm",
  "storage.mkdir",
  "storage.writeEncrypted",
  "storage.readEncrypted",
] as const satisfies readonly HostApiPath[];

/** One of the twelve. */
export type StorageHostApiPath = (typeof STORAGE_HOSTAPI_PATHS)[number];

/**
 * The eleven that reach the host. `storage.resolve` is excluded by NAME here
 * and by its `child-local` contract at the dispatcher; the dispatcher's own
 * child-local test is what keeps the two statements from disagreeing.
 */
export type DispatchedStorageHostApiPath = Exclude<
  StorageHostApiPath,
  "storage.resolve"
>;

/** One member of the child's hostApi stub, before `PluginHostApi` narrows it. */
export type ChildHostApiMember = (...args: unknown[]) => unknown;

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
 * Refuse to relay a member whose contract does not say "send it as it is".
 *
 * Fail-closed at stub construction rather than at the call: a path that gained
 * an `encoded` axis would otherwise keep crossing through a relay that does no
 * encoding, and the symptom would be a wrong value rather than a failure.
 */
function assertRelayable(path: StorageHostApiPath): void {
  const contract = HOSTAPI_PATH_CONTRACTS[path];
  if (
    contract.arguments !== "plain-json"
    || (contract.result !== "plain-json" && contract.result !== "void")
    || contract.lifetime !== "none"
  ) {
    throw new Error(
      `[host-api-storage-child] '${path}' no longer crosses as plain JSON `
        + `(arguments=${contract.arguments} result=${contract.result} `
        + `lifetime=${contract.lifetime}) — it needs a stub of its own`,
    );
  }
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
