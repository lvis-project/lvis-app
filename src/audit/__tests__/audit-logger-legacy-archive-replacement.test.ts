/**
 * Legacy audit archival must publish the bytes it verified.
 *
 * Issue #1746: archival used to verify the active pathname, close it, then
 * rename that *name* into the `legacy-unverified-` archive. A local process
 * replacing the file in the gap made the archived bytes differ from the
 * verified bytes. The swap below is injected at exactly that point — after the
 * verification reader drains, before publication — by wrapping the reader the
 * production code drives, so it lands in the real window rather than a
 * simulated one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { join } from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

// Both readers are wrapped: the pathname reader is what the pre-fix code used
// and the descriptor reader is what the fixed code uses, so the injection point
// survives the fix instead of quietly going dormant.
let afterVerification: (() => void) | null = null;
vi.mock("../jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jsonl-reader.js")>();
  const runHook = (): void => {
    const hook = afterVerification;
    afterVerification = null;
    hook?.();
  };
  return {
    ...actual,
    iterateJsonlLines: async function* (...args: Parameters<typeof actual.iterateJsonlLines>) {
      yield* actual.iterateJsonlLines(...args);
      runHook();
    },
    iterateJsonlLinesFromFd: async function* (
      ...args: Parameters<typeof actual.iterateJsonlLinesFromFd>
    ) {
      yield* actual.iterateJsonlLinesFromFd(...args);
      runHook();
    },
  };
});

import { AuditLogger } from "../audit-logger.js";
import { computeLineHmac, GENESIS_MARKER, MemorySecretStore } from "../hmac-chain.js";

const SECRET = "ff".repeat(32);
const LEGACY_LINE = JSON.stringify({
  decision: "allow",
  auditId: "legacy-tail",
  ts: "2026-05-09T00:00:00.000Z",
  trustOrigin: "user-keyboard",
  prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
});
const ATTACKER_LINE = JSON.stringify({
  decision: "allow",
  auditId: "attacker-substituted",
  ts: "2026-05-09T00:00:00.000Z",
  trustOrigin: "user-keyboard",
  prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
});

let testHome: string;
let auditDir: string;
let loggers: AuditLogger[];

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-legacy-archive-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  loggers = [];
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(async () => {
  afterVerification = null;
  await Promise.all(loggers.map((logger) => logger.close()));
  if (existsSync(testHome)) {
    // Not a bare `rmSync`: a foreign handle inside the tree refuses removal,
    // and `rmSync`'s own maxRetries does not cover that error. See
    // `src/__tests__/support/tmp-dir-teardown.ts`.
    await cleanupTmpDir(testHome);
  }
  vi.restoreAllMocks();
});

function createAuditLogger(): AuditLogger {
  const logger = new AuditLogger();
  loggers.push(logger);
  return logger;
}

function legacyArchives(): string[] {
  return readdirSync(auditDir).filter((name) =>
    name.includes("permission-audit.legacy-unverified-"),
  );
}

describe("legacy audit archival under pathname replacement", () => {
  it("archives the verified bytes, not whatever replaced the pathname", async () => {
    const logger = createAuditLogger();
    const activeFile = logger.getPermissionAuditLogFile();
    writeFileSync(activeFile, `${LEGACY_LINE}\n`, "utf-8");

    let replaced = false;
    afterVerification = () => {
      // A local process swaps a different file into the verified pathname.
      // Windows refuses this while the descriptor is held open; that refusal is
      // itself the guarantee, so tolerate it and assert on the outcome.
      const substitute = join(auditDir, "substitute.jsonl");
      writeFileSync(substitute, `${ATTACKER_LINE}\n`, "utf-8");
      try {
        renameSync(substitute, activeFile);
        replaced = true;
      } catch {
        rmSync(substitute, { force: true });
      }
    };

    const outcome = await logger
      .setupPermissionAuditChain(SECRET, new MemorySecretStore())
      .then(() => "resolved" as const, () => "rejected" as const);
    expect(afterVerification).toBeNull(); // the swap really ran in the window

    // The archive is forensic evidence of the tail that was authenticated. It
    // must never contain bytes the verification loop did not read.
    const archives = legacyArchives();
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(auditDir, archives[0]), "utf-8")).toBe(`${LEGACY_LINE}\n`);

    if (outcome === "resolved") {
      // A started epoch means the pathname still held the emptied descriptor.
      expect(replaced).toBe(false);
      expect(readFileSync(activeFile, "utf-8")).toBe("");
      expect(logger.isPermissionAuditChainReady()).toBe(true);
    } else {
      // Otherwise archival fails closed: no chain is started over the
      // substituted bytes.
      expect(replaced).toBe(true);
      expect(logger.isPermissionAuditChainReady()).toBe(false);
    }
  });

  it("starts a fresh genesis epoch when the pathname is left alone", async () => {
    const logger = createAuditLogger();
    const activeFile = logger.getPermissionAuditLogFile();
    writeFileSync(activeFile, `${LEGACY_LINE}\n`, "utf-8");

    await logger.setupPermissionAuditChain(SECRET, new MemorySecretStore());

    const archives = legacyArchives();
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(auditDir, archives[0]), "utf-8")).toBe(`${LEGACY_LINE}\n`);
    expect(readFileSync(activeFile, "utf-8")).toBe("");

    const appended = await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "fresh-epoch",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      layer: 1,
    } as Parameters<AuditLogger["appendPermissionAuditEntry"]>[0]);
    expect(appended.prevHash).toBe(computeLineHmac(SECRET, GENESIS_MARKER));
  });
});
