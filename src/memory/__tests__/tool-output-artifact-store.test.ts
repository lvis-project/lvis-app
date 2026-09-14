import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, symlinkSync, truncateSync,
  unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolOutputArtifactStore } from "../tool-output-artifact-store.js";
import {
  MAX_SESSION_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_PENDING_BYTES, MAX_TOOL_RESULT_ARTIFACT_BYTES,
  type ToolOutputArtifactInfo, type ToolOutputCapture,
} from "../../shared/tool-output-artifact.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual, openSync: vi.fn(actual.openSync), fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync), readSync: vi.fn(actual.readSync),
  };
});
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const SESSION_ID = "6eb01b95-755a-454a-9e53-59b203a41f70";
const OTHER_SESSION_ID = "85823eab-06aa-4e97-8774-3639c05d6b26";
let root: string;
let sessions: string;
let store: ToolOutputArtifactStore;

beforeEach(() => {
  vi.mocked(openSync).mockImplementation(actualFs.openSync);
  vi.mocked(fstatSync).mockImplementation(actualFs.fstatSync);
  vi.mocked(lstatSync).mockImplementation(actualFs.lstatSync);
  vi.mocked(readSync).mockImplementation(actualFs.readSync);
  root = mkdtempSync(join(tmpdir(), "tool-output-store-"));
  sessions = join(root, "sessions");
  mkdirSync(sessions, { mode: 0o700 });
  store = new ToolOutputArtifactStore(sessions);
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function outputDir(sessionId = SESSION_ID): string { return join(sessions, sessionId, "tool-output"); }
function onlyFile(suffix: string): string {
  const names = readdirSync(outputDir()).filter((name) => name.endsWith(suffix));
  expect(names).toHaveLength(1);
  return join(outputDir(), names[0]!);
}
async function appendBytes(capture: ToolOutputCapture, bytes: Buffer): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    if (!capture.append(bytes.subarray(offset, offset + 65_536))) await capture.waitForDrain();
  }
}
async function saved(text = "  output\r\n\r\n", toolUseId = "tool-output") {
  const capture = store.start(SESSION_ID, toolUseId);
  await appendBytes(capture, Buffer.from(text));
  return capture.finish();
}

describe("session tool output artifacts", () => {
  it("preserves raw whitespace, byte order and Unicode across writes and reload", async () => {
    const text = "\ufeff  α😀\r\n\tend  \r\n";
    const bytes = Buffer.from(text);
    const capture = store.start(SESSION_ID, "call/opaque:identifier");
    for (const byte of bytes) capture.append(Buffer.from([byte]));
    const firstFinish = capture.finish();
    expect(capture.finish()).toBe(firstFinish);
    const info = await firstFinish;
    expect(info).toMatchObject({
      status: "complete", capturedBytes: bytes.length, observedBytes: bytes.length,
      capturedChars: text.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(readFileSync(onlyFile(".bin"))).toEqual(bytes);
    expect(new ToolOutputArtifactStore(sessions).read(SESSION_ID, "call/opaque:identifier", info)).toBe(text);
    expect(() => capture.append(Buffer.from("late"))).toThrow("capture-finished");
    if (process.platform !== "win32") {
      expect(lstatSync(outputDir()).mode & 0o777).toBe(0o700);
      expect(lstatSync(onlyFile(".bin")).mode & 0o777).toBe(0o600);
      expect(lstatSync(onlyFile(".json")).mode & 0o777).toBe(0o600);
    }
  });

  it("owns queued bytes rather than retaining mutable caller buffers", async () => {
    const capture = store.start(SESSION_ID, "copy");
    const bytes = Buffer.from("original");
    capture.append(bytes);
    bytes.fill(0);
    expect(store.read(SESSION_ID, "copy", await capture.finish())).toBe("original");
  });

  it("omits a trailing incomplete UTF-8 code point only for partial capture", async () => {
    const bytes = Buffer.concat([Buffer.from("ok😀"), Buffer.from([0xf0, 0x9f])]);
    const capture = store.start(SESSION_ID, "cancelled");
    capture.append(bytes);
    const info = await capture.finish(true);
    expect(info).toMatchObject({ status: "partial", reason: "interrupted", capturedBytes: bytes.length, capturedChars: 4 });
    expect(readFileSync(onlyFile(".bin"))).toEqual(bytes);
    expect(store.read(SESSION_ID, "cancelled", info)).toBe("ok😀");
    const complete = store.start(SESSION_ID, "complete-invalid-utf8");
    complete.append(bytes);
    const completeInfo = await complete.finish();
    expect(store.read(SESSION_ID, "complete-invalid-utf8", completeInfo)).toBe("ok😀�");
  });

  it("retains the artifact limit prefix while continuing to observe discarded output", async () => {
    const capture = store.start(SESSION_ID, "limit");
    const bytes = Buffer.alloc(MAX_TOOL_RESULT_ARTIFACT_BYTES + 100, 97);
    await appendBytes(capture, bytes);
    expect(capture.append(Buffer.from("tail"))).toBe(true);
    const info = await capture.finish();
    expect(info).toMatchObject({
      status: "partial", reason: "artifact-limit", capturedBytes: MAX_TOOL_RESULT_ARTIFACT_BYTES,
      observedBytes: bytes.length + 4,
    });
    expect(store.read(SESSION_ID, "limit", info)?.length).toBe(MAX_TOOL_RESULT_ARTIFACT_BYTES);
  });

  it("backpressures accepted bytes and drains after a delayed write", async () => {
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolveGate) => { releaseWrite = resolveGate; });
    store._writeForTest = async (fd, bytes, offset, length, position) => {
      await gate;
      return writeSync(fd, bytes, offset, length, position);
    };
    const capture = store.start(SESSION_ID, "backpressure");
    expect(capture.append(Buffer.alloc(MAX_TOOL_OUTPUT_PENDING_BYTES, 97))).toBe(false);
    let drained = false;
    const draining = capture.waitForDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseWrite();
    await draining;
    expect((await capture.finish()).status).toBe("complete");
  });

  it("marks queue overflow explicitly without retaining or stalling later bytes", async () => {
    const capture = store.start(SESSION_ID, "queue");
    capture.append(Buffer.alloc(200_000, 97));
    expect(capture.append(Buffer.alloc(100_000, 98))).toBe(true);
    expect(capture.append(Buffer.from("discard"))).toBe(true);
    await capture.waitForDrain();
    const info = await capture.finish();
    expect(info).toMatchObject({ status: "partial", reason: "queue-limit", capturedBytes: 200_000, observedBytes: 300_007 });
  });

  it("rejects a single excessive chunk without allocating an artifact-sized queue", async () => {
    const capture = store.start(SESSION_ID, "large-chunk");
    expect(capture.append(Buffer.alloc(MAX_TOOL_OUTPUT_PENDING_BYTES + 1))).toBe(true);
    await capture.waitForDrain();
    expect(await capture.finish()).toMatchObject({ status: "unavailable", reason: "queue-limit", capturedBytes: 0 });
    expect(readdirSync(outputDir())).toEqual([]);
  });

  it("accounts only bytes actually written when a short write is followed by failure", async () => {
    let writes = 0;
    store._writeForTest = async (fd, bytes, offset, length, position) => {
      if (writes++ > 0) throw new Error("disk full");
      return writeSync(fd, bytes, offset, Math.min(3, length), position);
    };
    const capture = store.start(SESSION_ID, "short-write");
    capture.append(Buffer.from("abcdef"));
    await capture.waitForDrain();
    expect(capture.append(Buffer.from("discard"))).toBe(true);
    const info = await capture.finish();
    expect(info).toMatchObject({ status: "partial", reason: "write-failed", capturedBytes: 3, observedBytes: 13 });
    expect(store.read(SESSION_ID, "short-write", info)).toBe("abc");
  });

  it("settles unavailable on immediate disk failure and releases its reservation", async () => {
    store._writeForTest = async () => { throw new Error("write failed"); };
    const capture = store.start(SESSION_ID, "failed");
    expect(capture.append(Buffer.alloc(MAX_TOOL_OUTPUT_PENDING_BYTES))).toBe(false);
    await capture.waitForDrain();
    expect(await capture.finish()).toMatchObject({ status: "unavailable", reason: "write-failed" });
    expect(readdirSync(outputDir())).toEqual([]);
    const all = Array.from({ length: 4 }, (_, index) => new ToolOutputArtifactStore(sessions).start(SESSION_ID, `next-${index}`));
    expect((await all[0]!.finish()).status).toBe("complete");
    await Promise.all(all.slice(1).map((entry) => entry.finish()));
  });

  it("reserves the full allowance across overlapping store instances", async () => {
    const all = Array.from({ length: 4 }, (_, index) => new ToolOutputArtifactStore(sessions).start(SESSION_ID, `active-${index}`));
    const rejected = store.start(SESSION_ID, "overbooked");
    rejected.append(Buffer.from("observed"));
    expect(await rejected.finish()).toMatchObject({ status: "unavailable", reason: "session-limit", observedBytes: 8 });
    await all[0]!.finish();
    const admitted = store.start(SESSION_ID, "released");
    admitted.append(Buffer.from("allowed"));
    expect((await admitted.finish()).status).toBe("complete");
    await Promise.all(all.slice(1).map((entry) => entry.finish()));
  });

  it("counts retained payloads after reload and returns quota after pruning", async () => {
    const infos = [];
    for (let index = 0; index < 4; index++) {
      const capture = store.start(SESSION_ID, `full-${index}`);
      await appendBytes(capture, Buffer.alloc(MAX_TOOL_RESULT_ARTIFACT_BYTES, 97));
      infos.push(await capture.finish());
    }
    const reloaded = new ToolOutputArtifactStore(sessions);
    expect(await reloaded.start(SESSION_ID, "full-session").finish()).toMatchObject({ reason: "session-limit" });
    reloaded.prune(SESSION_ID, new Set(infos.slice(1).map((info) => info.captureId)));
    expect(reloaded.read(SESSION_ID, "full-0", infos[0]!)).toBeNull();
    expect(reloaded.read(SESSION_ID, "full-1", infos[1]!)).toHaveLength(MAX_TOOL_RESULT_ARTIFACT_BYTES);
    expect((await reloaded.start(SESSION_ID, "after-prune").finish()).status).toBe("complete");
  });

  it("counts orphaned payloads when metadata publication fails", async () => {
    store._beforePublishForTest = (stage) => { if (stage === "metadata") throw new Error("publish failed"); };
    for (let index = 0; index < 4; index++) {
      const capture = store.start(SESSION_ID, `orphan-${index}`);
      await appendBytes(capture, Buffer.alloc(MAX_TOOL_RESULT_ARTIFACT_BYTES, 97));
      expect(await capture.finish()).toMatchObject({ status: "unavailable", reason: "write-failed" });
    }
    expect(readdirSync(outputDir()).filter((name) => name.endsWith(".bin"))).toHaveLength(4);
    expect(await new ToolOutputArtifactStore(sessions).start(SESSION_ID, "over-orphans").finish())
      .toMatchObject({ reason: "session-limit" });
  });

  it("counts abandoned temporary payloads independently of valid metadata", async () => {
    await saved();
    const orphan = join(outputDir(), ".abandoned.part");
    writeFileSync(orphan, "", { mode: 0o600 });
    truncateSync(orphan, MAX_SESSION_TOOL_OUTPUT_BYTES - MAX_TOOL_RESULT_ARTIFACT_BYTES + 1);
    expect(await store.start(SESSION_ID, "over-temporary").finish()).toMatchObject({ reason: "session-limit" });
  });

  it("keeps active captures and explicitly retained references during prune", async () => {
    const retained = await saved("retained", "keep");
    const discarded = await saved("discarded", "remove");
    const active = store.start(SESSION_ID, "active");
    active.append(Buffer.from("active output"));
    await active.waitForDrain();
    new ToolOutputArtifactStore(sessions).prune(SESSION_ID, new Set([retained.captureId]));
    expect(store.read(SESSION_ID, "keep", retained)).toBe("retained");
    expect(store.read(SESSION_ID, "remove", discarded)).toBeNull();
    const activeInfo = await active.finish();
    expect(store.read(SESSION_ID, "active", activeInfo)).toBe("active output");
  });

  it("rejects invalid session/tool identities before any file creation", () => {
    const beforeAdmission = vi.fn();
    for (const id of ["../outside", "", "session", `${SESSION_ID}/child`]) expect(() => store.start(id, "tool", beforeAdmission)).toThrow();
    for (const id of ["", "bad\nidentity", "x".repeat(257)]) expect(() => store.start(SESSION_ID, id, beforeAdmission)).toThrow();
    expect(beforeAdmission).not.toHaveBeenCalled();
    expect(readdirSync(sessions)).toEqual([]);
  });

  it.each(["EACCES", "EISDIR"])("observes output when admission preparation fails with %s", async (code) => {
    const beforeAdmission = vi.fn(() => { throw Object.assign(new Error("preparation failed"), { code }); });
    const capture = store.start(SESSION_ID, "preparation", beforeAdmission);
    expect(beforeAdmission).toHaveBeenCalledOnce();
    expect(readdirSync(sessions)).toEqual([]);
    capture.append(Buffer.from("α😀"));
    await capture.waitForDrain();
    expect(await capture.finish()).toMatchObject({
      status: "unavailable", reason: "write-failed", capturedBytes: 0, observedBytes: 6,
    });
    const admitted = Array.from({ length: 4 }, (_, index) => store.start(SESSION_ID, `after-preparation-${index}`));
    expect((await Promise.all(admitted.map((entry) => entry.finish()))).every((info) => info.status === "complete")).toBe(true);
  });

  it("binds metadata to the exact session, tool and capture reference", async () => {
    const info = await saved("private", "owned");
    expect(store.read(OTHER_SESSION_ID, "owned", info)).toBeNull();
    expect(store.read(SESSION_ID, "other", info)).toBeNull();
    expect(store.read(SESSION_ID, "owned", { ...info, observedBytes: info.observedBytes + 1 })).toBeNull();
    const metadata = onlyFile(".json");
    const record = JSON.parse(readFileSync(metadata, "utf8")) as { toolUseId: string };
    record.toolUseId = "replacement";
    writeFileSync(metadata, JSON.stringify(record));
    expect(store.read(SESSION_ID, "owned", info)).toBeNull();
    store.prune(SESSION_ID, new Set());
    expect(existsSync(onlyFile(".bin"))).toBe(true);
  });

  it("validates complete and partial references after reload without hydrating output", async () => {
    const complete = await saved("original", "complete");
    const partialCapture = store.start(SESSION_ID, "partial");
    partialCapture.append(Buffer.from("partial"));
    const partial = await partialCapture.finish(true);
    const reloaded = new ToolOutputArtifactStore(sessions);
    expect(reloaded.validateReference(SESSION_ID, "complete", complete)).toBe(true);
    expect(reloaded.validateReference(SESSION_ID, "partial", partial)).toBe(true);
    // Same-sized content corruption is detected by explicit recovery, not by
    // the cheap reference check performed while loading bounded history rows.
    const data = readdirSync(outputDir()).find((name) => name.endsWith(`${complete.captureId}.bin`))!;
    writeFileSync(join(outputDir(), data), "modified");
    expect(reloaded.validateReference(SESSION_ID, "complete", complete)).toBe(true);
    expect(reloaded.read(SESSION_ID, "complete", complete)).toBeNull();
  });

  it("preserves a valid unavailable reference without requiring backing files", async () => {
    const capture = store.start(SESSION_ID, "unavailable");
    capture.append(Buffer.alloc(MAX_TOOL_OUTPUT_PENDING_BYTES + 1));
    const info = await capture.finish();
    rmSync(join(sessions, SESSION_ID), { recursive: true });
    expect(store.validateReference(SESSION_ID, "unavailable", info)).toBe(true);
    expect(store.validateReference("../outside", "unavailable", info)).toBe(false);
    expect(store.validateReference(SESSION_ID, "bad\nidentity", info)).toBe(false);
    expect(store.validateReference(SESSION_ID, "unavailable", { ...info, reason: undefined })).toBe(false);
    expect(existsSync(join(sessions, SESSION_ID))).toBe(false);
  });

  it("rejects missing, cross-session, forged and expanded references", async () => {
    const info = await saved("owned");
    expect(store.validateReference(OTHER_SESSION_ID, "tool-output", info)).toBe(false);
    expect(store.validateReference(SESSION_ID, "another-tool", info)).toBe(false);
    expect(store.validateReference(SESSION_ID, "tool-output", { ...info, sha256: "f".repeat(64) })).toBe(false);
    expect(store.validateReference(SESSION_ID, "tool-output", { ...info, path: "outside" } as ToolOutputArtifactInfo)).toBe(false);
    unlinkSync(onlyFile(".bin"));
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
  });

  it("rejects oversized and mismatched metadata during reference validation", async () => {
    const info = await saved("owned");
    const metadata = onlyFile(".json");
    const original = readFileSync(metadata, "utf8");
    const record = JSON.parse(original) as Record<string, unknown>;
    for (const modified of [
      { ...record, sessionId: OTHER_SESSION_ID }, { ...record, toolUseId: "other" },
      { ...record, extra: true }, { ...record, info: { ...info, capturedChars: 0 } },
    ]) {
      writeFileSync(metadata, JSON.stringify(modified));
      expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
    }
    writeFileSync(metadata, original + " ".repeat(4096));
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
  });

  it("requires a private, single-link regular payload with its recorded size", async () => {
    const info = await saved("owned");
    const data = onlyFile(".bin");
    truncateSync(data, info.capturedBytes + 1);
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
    truncateSync(data, info.capturedBytes);
    const outside = join(root, "linked-output");
    linkSync(data, outside);
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
    unlinkSync(outside);
    if (process.platform !== "win32") {
      chmodSync(data, 0o644);
      expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
      chmodSync(data, 0o600);
    }
    unlinkSync(data);
    symlinkSync(join(root, "missing-output"), data);
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
    unlinkSync(data);
    mkdirSync(data, { mode: 0o700 });
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
  });

  it("rejects references when the owned directory is replaced by a symlink", async () => {
    const info = await saved("owned");
    const moved = join(sessions, SESSION_ID, "moved-output");
    renameSync(outputDir(), moved);
    symlinkSync(moved, outputDir(), "dir");
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
  });

  it("rejects modified or oversized payloads before exposing text", async () => {
    const info = await saved("abc");
    const data = onlyFile(".bin");
    writeFileSync(data, "abd");
    expect(store.read(SESSION_ID, "tool-output", info)).toBeNull();
    truncateSync(data, MAX_TOOL_RESULT_ARTIFACT_BYTES + 1);
    expect(store.read(SESSION_ID, "tool-output", info)).toBeNull();
  });

  it.each(["root", "session", "output"])("refuses a symlink at the %s directory", async (level) => {
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    if (level === "root") {
      rmSync(sessions, { recursive: true });
      symlinkSync(outside, sessions, "dir");
    } else if (level === "session") symlinkSync(outside, join(sessions, SESSION_ID), "dir");
    else {
      mkdirSync(join(sessions, SESSION_ID), { mode: 0o700 });
      symlinkSync(outside, outputDir(), "dir");
    }
    const capture = store.start(SESSION_ID, "symlink");
    capture.append(Buffer.from("secret"));
    expect(await capture.finish()).toMatchObject({ status: "unavailable", reason: "write-failed" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("does not follow a replaced payload during reads or pruning", async () => {
    const info = await saved("original");
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "untouched", { mode: 0o600 });
    const data = onlyFile(".bin");
    unlinkSync(data);
    symlinkSync(outside, data);
    expect(store.read(SESSION_ID, "tool-output", info)).toBeNull();
    store.prune(SESSION_ID, new Set());
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(lstatSync(data).isSymbolicLink()).toBe(true);
  });

  it.each([".bin", ".json"])("validates an opened %s descriptor before inspecting its path", async (suffix) => {
    const info = await saved("original");
    const path = onlyFile(suffix);
    const events: string[] = [];
    let openedFd = -1;
    let openedFlags: string | number = "";
    vi.mocked(openSync).mockImplementation((...args) => {
      const fd = actualFs.openSync(...args);
      if (args[0] === path) {
        openedFd = fd;
        openedFlags = args[1];
        events.push("open");
      }
      return fd;
    });
    vi.mocked(fstatSync).mockImplementation((...args) => {
      if (args[0] === openedFd) events.push("fstat");
      return actualFs.fstatSync(...args);
    });
    vi.mocked(lstatSync).mockImplementation((...args) => {
      if (args[0] === path) events.push("lstat");
      return actualFs.lstatSync(...args);
    });
    expect(store.read(SESSION_ID, "tool-output", info)).toBe("original");
    expect(events.slice(0, 3)).toEqual(["open", "fstat", "lstat"]);
    expect(openedFlags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    expect(() => actualFs.fstatSync(openedFd)).toThrow();
  });

  it.each([
    [".bin", "open"], [".json", "open"], [".bin", "read"], [".json", "read"],
  ])("rejects a %s path replaced after descriptor %s and closes the descriptor", async (suffix, phase) => {
    const info = await saved("original");
    const path = onlyFile(suffix!);
    const original = readFileSync(path);
    let openedFd = -1;
    let replaced = false;
    const replace = () => {
      if (replaced) return;
      replaced = true;
      renameSync(path, `${path}.moved`);
      writeFileSync(path, original, { mode: 0o600 });
    };
    vi.mocked(openSync).mockImplementation((...args) => {
      const fd = actualFs.openSync(...args);
      if (args[0] === path) {
        openedFd = fd;
        if (phase === "open") replace();
      }
      return fd;
    });
    vi.mocked(readSync).mockImplementation((...args) => {
      const bytesRead = actualFs.readSync(...args);
      if (args[0] === openedFd && phase === "read") replace();
      return bytesRead;
    });
    expect(store.read(SESSION_ID, "tool-output", info)).toBeNull();
    expect(replaced).toBe(true);
    expect(readFileSync(path)).toEqual(original);
    expect(() => actualFs.fstatSync(openedFd)).toThrow();
  });

  it.skipIf(process.platform === "win32").each([".bin", ".json"])("rejects a FIFO %s without blocking or removing it", async (suffix) => {
    const info = await saved("original");
    const data = onlyFile(suffix);
    unlinkSync(data);
    expect(spawnSync("mkfifo", [data]).status).toBe(0);
    expect(store.validateReference(SESSION_ID, "tool-output", info)).toBe(false);
    expect(store.read(SESSION_ID, "tool-output", info)).toBeNull();
    store.prune(SESSION_ID, new Set());
    expect(lstatSync(data).isFIFO()).toBe(true);
  });

  it("recovers interrupted publication pairs without removing their published bytes", async () => {
    const info = await saved("published");
    const data = onlyFile(".bin");
    const metadata = onlyFile(".json");
    const dataName = readdirSync(outputDir()).find((name) => name.endsWith(".bin"))!;
    const stem = dataName.slice(0, -4);
    const temporaryData = join(outputDir(), `.${stem}.part`);
    const temporaryMetadata = join(outputDir(), `.${stem}.json.tmp`);
    linkSync(data, temporaryData);
    linkSync(metadata, temporaryMetadata);
    const reloaded = new ToolOutputArtifactStore(sessions);
    expect(reloaded.read(SESSION_ID, "tool-output", info)).toBe("published");
    expect(existsSync(temporaryData)).toBe(false);
    expect(existsSync(temporaryMetadata)).toBe(false);
    expect((await reloaded.start(SESSION_ID, "after-recovery").finish()).status).toBe("complete");
  });

  it("does not recover a hard link outside the capture directory", async () => {
    const info = await saved("published");
    const data = onlyFile(".bin");
    const outside = join(root, "outside-link");
    linkSync(data, outside);
    expect(store.read(SESSION_ID, "tool-output", info)).toBeNull();
    store.prune(SESSION_ID, new Set());
    expect(readFileSync(outside, "utf8")).toBe("published");
    expect(existsSync(data)).toBe(true);
  });

  it("rejects directory replacement during capture without deleting the replacement", async () => {
    const capture = store.start(SESSION_ID, "directory-race");
    capture.append(Buffer.from("before"));
    await capture.waitForDrain();
    renameSync(outputDir(), join(sessions, SESSION_ID, "moved-output"));
    mkdirSync(outputDir(), { mode: 0o700 });
    writeFileSync(join(outputDir(), "sentinel"), "untouched", { mode: 0o600 });
    expect(await capture.finish()).toMatchObject({ status: "unavailable", reason: "write-failed" });
    expect(readFileSync(join(outputDir(), "sentinel"), "utf8")).toBe("untouched");
  });

  it.skipIf(process.platform === "win32")("retains quota when directory permissions prevent pruning", async () => {
    const capture = store.start(SESSION_ID, "retained");
    await appendBytes(capture, Buffer.alloc(MAX_TOOL_RESULT_ARTIFACT_BYTES, 97));
    const info = await capture.finish();
    const orphan = join(outputDir(), "retained-orphan.bin");
    writeFileSync(orphan, "", { mode: 0o600 });
    truncateSync(orphan, MAX_SESSION_TOOL_OUTPUT_BYTES - MAX_TOOL_RESULT_ARTIFACT_BYTES);
    chmodSync(outputDir(), 0o500);
    store.prune(SESSION_ID, new Set());
    chmodSync(outputDir(), 0o700);
    expect(store.read(SESSION_ID, "retained", info)).toHaveLength(MAX_TOOL_RESULT_ARTIFACT_BYTES);
    expect(await store.start(SESSION_ID, "still-full").finish()).toMatchObject({ reason: "session-limit" });
  });
});
