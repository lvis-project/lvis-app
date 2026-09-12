import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { SecretEncryptionUnavailableError, type SecretEncryption } from "./secret-document-store.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
// The algorithm and format version are authenticated along with the content.
const ENVELOPE_HEADER = Buffer.from("lvis-external-key:aes-256-gcm:1\0", "ascii");

export class SecretKeyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyFileError";
  }
}

function assertPrivateKeyFile(stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new SecretKeyFileError("Secret key must be a regular file with no symbolic or hard links");
  }
  if (stats.uid !== process.geteuid!()) {
    throw new SecretKeyFileError("Secret key file must be owned by the current user");
  }
  const mode = stats.mode & 0o7777;
  if (mode !== 0o400 && mode !== 0o600) {
    throw new SecretKeyFileError("Secret key file must have mode 0400 or 0600");
  }
  if (stats.size !== KEY_BYTES) {
    throw new SecretKeyFileError("Secret key file must contain exactly 32 raw bytes");
  }
}

function sameKeyFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readKeyWindow(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new SecretKeyFileError("Secret key file changed during read");
    offset += count;
  }
}

function readPrivateKey(keyFilePath: string): KeyObject {
  if (!isAbsolute(keyFilePath) || keyFilePath.includes("\0")) {
    throw new SecretKeyFileError("Secret key file path must be absolute");
  }
  if ((process.platform !== "linux" && process.platform !== "darwin")
    || typeof process.geteuid !== "function" || !constants.O_NOFOLLOW) {
    throw new SecretKeyFileError("Protected external key files are unavailable on this platform");
  }
  let fd: number | undefined;
  const bytes = Buffer.alloc(KEY_BYTES);
  const verification = Buffer.alloc(KEY_BYTES);
  try {
    const before = lstatSync(keyFilePath);
    assertPrivateKeyFile(before);
    // NONBLOCK also prevents a replacement FIFO from hanging startup between
    // the path check and the descriptor check.
    fd = openSync(keyFilePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    assertPrivateKeyFile(opened);
    if (!sameKeyFile(before, opened)) throw new SecretKeyFileError("Secret key file changed during read");
    readKeyWindow(fd, bytes);
    readKeyWindow(fd, verification);
    const afterHandle = fstatSync(fd);
    const afterPath = lstatSync(keyFilePath);
    assertPrivateKeyFile(afterHandle);
    assertPrivateKeyFile(afterPath);
    if (!sameKeyFile(opened, afterHandle) || !sameKeyFile(opened, afterPath)
      || !timingSafeEqual(bytes, verification)) {
      throw new SecretKeyFileError("Secret key file changed during read");
    }
    return createSecretKey(bytes);
  } catch (error) {
    if (error instanceof SecretKeyFileError) throw error;
    // Do not expose file content, the path, or an underlying provider error.
    throw new SecretKeyFileError("Secret key file could not be read safely");
  } finally {
    bytes.fill(0);
    verification.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The host supplies the path to an existing protected key. Key creation,
 * backup and rotation belong to the operator. The key is pinned for this
 * process lifetime; a different key file takes effect on the next startup.
 */
export function createNodeSecretEncryption(keyFilePath?: string): SecretEncryption {
  const key = keyFilePath === undefined ? undefined : readPrivateKey(keyFilePath);
  return Object.freeze({
    isEncryptionAvailable: () => key !== undefined,
    getSelectedStorageBackend: () => "external_key" as const,
    encryptString(value: string): Buffer {
      if (!key) throw new SecretEncryptionUnavailableError();
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_BYTES });
      cipher.setAAD(ENVELOPE_HEADER);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([ENVELOPE_HEADER, nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value: Buffer): string {
      if (!key) throw new SecretEncryptionUnavailableError();
      const nonceStart = ENVELOPE_HEADER.length;
      const tagStart = nonceStart + NONCE_BYTES;
      const ciphertextStart = tagStart + AUTH_TAG_BYTES;
      if (value.length < ciphertextStart
        || !value.subarray(0, nonceStart).equals(ENVELOPE_HEADER)) {
        throw new Error("Secret ciphertext has an unsupported encryption format");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(nonceStart, tagStart), {
          authTagLength: AUTH_TAG_BYTES,
        });
        decipher.setAAD(ENVELOPE_HEADER);
        decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
        const plaintext = Buffer.concat([decipher.update(value.subarray(ciphertextStart)), decipher.final()]);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        } finally {
          plaintext.fill(0);
        }
      } catch {
        throw new Error("Secret ciphertext authentication failed");
      }
    },
  });
}
