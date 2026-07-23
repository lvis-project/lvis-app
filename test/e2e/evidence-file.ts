import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function openEvidence(path: string): number {
  const readWriteNoFollow = constants.O_RDWR | constants.O_CLOEXEC | constants.O_NOFOLLOW;
  try {
    return openSync(path, readWriteNoFollow);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return openSync(
      path,
      readWriteNoFollow | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
  }
}

export function mergeEvidenceFile(
  path: string,
  patch: Record<string, unknown>,
): void {
  if (!path) return;
  const fd = openEvidence(path);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_EVIDENCE_BYTES) {
      throw new Error("E2E evidence must be a regular file no larger than 1 MiB");
    }
    const raw = readFileSync(fd, "utf8");
    const current = raw.trim()
      ? JSON.parse(raw) as Record<string, unknown>
      : {};
    const rendered = Buffer.from(`${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
    if (rendered.byteLength > MAX_EVIDENCE_BYTES) {
      throw new Error("E2E evidence exceeds the 1 MiB limit");
    }
    writeSync(fd, rendered, 0, rendered.byteLength, 0);
    ftruncateSync(fd, rendered.byteLength);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
