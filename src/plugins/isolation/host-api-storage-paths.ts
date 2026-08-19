/**
 * The host end of `hostApi.storage.*`: eleven dispatchable members, one shape
 * (`docs/blueprints/plugin-process-isolation.md` §3.2).
 *
 * The twelfth, `storage.resolve`, is not here — its contract says `child-local`
 * and the dispatcher refuses it, so the child's copy of the lexical join
 * (`plugin-storage-containment.ts`) is the whole implementation.
 *
 * WHY THE GROUP IS WRITTEN TOGETHER. read/write × raw/text/json/encrypted is
 * the most symmetric corner of the surface, and the asymmetries in it are all
 * deliberate: exactly one member re-encodes its RESULT (`read`, because bytes
 * are not JSON), exactly one re-encodes its ARGUMENTS (`write`, same reason in
 * the other direction), and exactly two can fail for a reason unrelated to the
 * file (`writeEncrypted` / `readEncrypted`, when the OS keychain is not there).
 * Every other member is plain JSON in and plain JSON out. Written apart, those
 * four exceptions would be four independent judgement calls.
 *
 * ARGUMENT VALIDATION IS A BOUNDARY CONCERN, NOT A STORAGE ONE. `args` arrives
 * from the least-trusted process in the system, so each member checks its own
 * positional arguments against its declared signature and refuses a mismatch
 * with `argument-marshalling-rejected`. Stated deviation: in-process, a
 * non-string `relPath` reaches `guard()` and comes back as a
 * `PluginStorageError`; across the boundary it is refused here instead, because
 * a message whose arguments do not match the member's signature is a malformed
 * message and the storage implementation is not the right place to discover
 * that. A plugin passing the argument its own types declare never sees the
 * difference.
 *
 * Nothing here catches. A refused path, a missing file, a denied effect and an
 * unavailable keychain all propagate as the host classes they already are;
 * `classifyHostApiError` maps each to the code the member's contract lists.
 * There is no default value and no silent skip anywhere in this file.
 */
import type { StorageEncoding } from "../public-contract.js";
import type { HostApiCall } from "./host-api-dispatcher.js";
import {
  HostApiBoundaryError,
  decodeWireBytes,
  encodeWireBytes,
  type WireBytes,
} from "./host-api-wire.js";

/**
 * Every `StorageEncoding`, as a runtime membership test.
 *
 * `Record<StorageEncoding, true>` rather than an array: adding a member to the
 * union without adding it here is a COMPILE error, so the set cannot drift
 * behind the type it is guarding. Unvalidated, an attacker-chosen encoding
 * reaches `readFile`/`writeFile` and comes back as an opaque `host-internal`
 * throw; validated, it is the boundary refusal it actually is.
 */
const STORAGE_ENCODINGS: Record<StorageEncoding, true> = {
  "utf-8": true,
  utf8: true,
  ascii: true,
  base64: true,
  base64url: true,
  hex: true,
  latin1: true,
  binary: true,
};

function reject(call: HostApiCall, index: number, expected: string): never {
  throw new HostApiBoundaryError(
    "argument-marshalling-rejected",
    `[host-api-storage] '${call.path}' argument ${index} must be ${expected}`,
    { path: call.path, index },
  );
}

/** A required positional argument the member declares as `string`. */
function stringArg(call: HostApiCall, index: number): string {
  const value = call.args[index];
  if (typeof value !== "string") reject(call, index, "a string");
  return value;
}

/**
 * A positional argument the member declares OPTIONAL.
 *
 * Absent means absent: `describeNonJson` refuses `undefined` inside an array,
 * so an unsupplied trailing argument arrives as a shorter `args` — never as an
 * explicit `undefined` element.
 */
function optionalStringArg(call: HostApiCall, index: number): string | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "string") reject(call, index, "a string when present");
  return value;
}

function optionalEncodingArg(
  call: HostApiCall,
  index: number,
): StorageEncoding | undefined {
  const value = optionalStringArg(call, index);
  if (value === undefined) return undefined;
  // `Object.hasOwn`, not `in`: the value is child-supplied and
  // `"toString" in STORAGE_ENCODINGS` is true.
  if (!Object.hasOwn(STORAGE_ENCODINGS, value)) {
    reject(call, index, `one of ${Object.keys(STORAGE_ENCODINGS).join(", ")}`);
  }
  return value as StorageEncoding;
}

function optionalIndentArg(call: HostApiCall, index: number): number | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    reject(call, index, "a non-negative integer when present");
  }
  return value;
}

/** `rm`'s only option today. An unknown key is refused rather than ignored. */
function optionalRemoveOptionsArg(
  call: HostApiCall,
  index: number,
): { recursive?: boolean } | undefined {
  const value = call.args[index];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(call, index, "an options object when present");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries) {
    if (key !== "recursive" || typeof item !== "boolean") {
      reject(call, index, "an options object with only a boolean 'recursive'");
    }
  }
  return value as { recursive?: boolean };
}

/**
 * `storage.read` — the one member whose RESULT is re-encoded.
 *
 * It declares `Uint8Array` and delivers a Node `Buffer`, and `Buffer` carries a
 * `toJSON()`: a naive round trip does not throw, it SUCCEEDS into
 * `{ type: "Buffer", data: number[] }` — a different type that reads as a
 * successful read. Tagging the bytes as base64 is what keeps bytes bytes.
 */
export async function readStorageBytes(call: HostApiCall): Promise<WireBytes> {
  const bytes = await call.hostApi.storage.read(stringArg(call, 0));
  return encodeWireBytes(bytes, `${call.path}(result)`);
}

export async function readStorageText(call: HostApiCall): Promise<string> {
  return call.hostApi.storage.readText(
    stringArg(call, 0),
    optionalEncodingArg(call, 1),
  );
}

/** Resolves `null` for a missing file — the member's declared answer, not a fallback. */
export async function readStorageJson(call: HostApiCall): Promise<unknown> {
  return call.hostApi.storage.readJson(stringArg(call, 0));
}

export async function listStorageEntries(call: HostApiCall): Promise<string[]> {
  return call.hostApi.storage.list(optionalStringArg(call, 0));
}

export async function storageEntryExists(call: HostApiCall): Promise<boolean> {
  return call.hostApi.storage.exists(stringArg(call, 0));
}

/**
 * `storage.write` — the one member whose ARGUMENTS are re-encoded.
 *
 * `data` is `string | Uint8Array`, and the tag is what keeps the two branches
 * apart: without it a base64 STRING the plugin meant to write verbatim is
 * indistinguishable from bytes the child encoded, and the file lands decoded.
 * The separate `encoding` argument is orthogonal — it says how the host should
 * interpret a string it was given, not how the string crossed.
 */
export async function writeStorageBytes(call: HostApiCall): Promise<void> {
  const relPath = stringArg(call, 0);
  const data = decodeWireBytes(call.args[1], `${call.path}(data)`);
  await call.hostApi.storage.write(relPath, data, optionalEncodingArg(call, 2));
}

export async function writeStorageJson(call: HostApiCall): Promise<void> {
  const relPath = stringArg(call, 0);
  if (call.args.length < 2) reject(call, 1, "present");
  await call.hostApi.storage.writeJson(
    relPath,
    call.args[1],
    optionalIndentArg(call, 2),
  );
}

export async function removeStoragePath(call: HostApiCall): Promise<void> {
  const relPath = stringArg(call, 0);
  await call.hostApi.storage.rm(relPath, optionalRemoveOptionsArg(call, 1));
}

export async function makeStorageDirectory(call: HostApiCall): Promise<void> {
  await call.hostApi.storage.mkdir(stringArg(call, 0));
}

/**
 * Fails closed on a missing OS keychain with
 * `plugin-storage-encryption-unavailable`, which is a DIFFERENT answer from a
 * missing file: nothing was written, and the plaintext never reached the disk.
 */
export async function writeEncryptedStorage(call: HostApiCall): Promise<void> {
  const relPath = stringArg(call, 0);
  await call.hostApi.storage.writeEncrypted(relPath, stringArg(call, 1));
}

export async function readEncryptedStorage(call: HostApiCall): Promise<string> {
  return call.hostApi.storage.readEncrypted(stringArg(call, 0));
}
