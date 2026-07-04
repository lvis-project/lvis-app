/**
 * corp-ca-loader unit tests — §17 C1
 *
 * Mocks child_process.execFile and node:fs so every path can be tested without
 * touching the real keychain or filesystem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock node:child_process ──────────────────────────────────────────────────
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// ─── Mock node:fs (sync) — for cache reads and directory creation ────────────
vi.mock("node:fs", () => ({
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// ─── Mock node:fs/promises — for open() ──────────────────────────────────────
vi.mock("node:fs/promises", () => ({
  open: vi.fn(async () => ({
    writeFile: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  })),
}));

import * as cpMock from "node:child_process";
import * as fsMock from "node:fs";
import * as fspMock from "node:fs/promises";

const mockedExecFile = vi.mocked(cpMock.execFile);
const mockedCloseSync = vi.mocked(fsMock.closeSync);
const mockedFstatSync = vi.mocked(fsMock.fstatSync);
const mockedOpenSync = vi.mocked(fsMock.openSync);
const mockedReadFileSync = vi.mocked(fsMock.readFileSync);
const mockedMkdirSync = vi.mocked(fsMock.mkdirSync);
const mockedOpen = vi.mocked(fspMock.open);

// ─── Sample PEM fixture ───────────────────────────────────────────────────────
const SAMPLE_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" + "A".repeat(60),
  "-----END CERTIFICATE-----",
].join("\n") + "\n";

// ─── Fresh mtime helper ───────────────────────────────────────────────────────
function makeFreshStat(): ReturnType<typeof fsMock.fstatSync> {
  return { mtimeMs: Date.now() - 1000 } as ReturnType<typeof fsMock.fstatSync>;
}

function makeStalestat(): ReturnType<typeof fsMock.fstatSync> {
  // 8 days ago — beyond 7-day TTL
  return { mtimeMs: Date.now() - 8 * 24 * 60 * 60 * 1000 } as ReturnType<typeof fsMock.fstatSync>;
}

function mockExecFileStdout(stdout: string): void {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, "");
    return {} as ReturnType<typeof cpMock.execFile>;
  }) as never);
}

function mockExecFileError(err: Error): void {
  mockedExecFile.mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
    callback(err, "", "");
    return {} as ReturnType<typeof cpMock.execFile>;
  }) as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Save the real platform value once at module-evaluation time (before any mock).
const REAL_PLATFORM = process.platform;

describe("ensureCorporateCa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.platform to 'darwin' so extractByPlatform() calls extractMacos()
    // which invokes execSync — required for extraction tests to pass on Linux CI.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    // default: openSync throws ENOENT (no cache)
    mockedOpenSync.mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });
    // default: execFile returns empty string
    mockExecFileStdout("");
    // mkdirSync no-op
    mockedMkdirSync.mockReturnValue(undefined);
    mockedCloseSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true, writable: true });
    vi.resetModules();
  });

  it("execFile returns empty string → { pem: null, source: 'none' }", async () => {
    mockExecFileStdout("");

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.pem).toBeNull();
    expect(result.source).toBe("none");
    expect(result.certCount).toBe(0);
  });

  it("execFile returns valid PEM → { source: 'extracted' } + cache written", async () => {
    mockExecFileStdout(SAMPLE_PEM);

    const writtenChunks: string[] = [];
    const mockFd = {
      writeFile: vi.fn(async (data: string) => { writtenChunks.push(data); }),
      close: vi.fn(async () => undefined),
    };
    mockedOpen.mockResolvedValue(mockFd as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.pem).toBe(SAMPLE_PEM);
    expect(result.source).toBe("extracted");
    expect(result.certCount).toBe(1);
    // cache should have been written
    expect(mockedOpen).toHaveBeenCalledWith(
      expect.stringContaining("corp-ca.pem"),
      "w",
      0o600,
    );
    expect(mockFd.writeFile).toHaveBeenCalledWith(SAMPLE_PEM, "utf-8");
    expect(mockFd.close).toHaveBeenCalled();
  });

  it("cache file fresh (mtime < 7d) → execFile NOT called, source: 'cache'", async () => {
    mockedOpenSync.mockReturnValue(42 as never);
    mockedFstatSync.mockReturnValue(makeFreshStat());
    mockedReadFileSync.mockReturnValue(SAMPLE_PEM as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.source).toBe("cache");
    expect(result.pem).toBe(SAMPLE_PEM);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("cache file stale (mtime > 7d) → re-extracts, source: 'extracted'", async () => {
    mockedOpenSync.mockReturnValue(42 as never);
    mockedFstatSync.mockReturnValue(makeStalestat());
    // stale cache content (still valid PEM — but older than 7d)
    mockedReadFileSync.mockReturnValue(SAMPLE_PEM as never);
    // execFile returns fresh PEM
    mockExecFileStdout(SAMPLE_PEM);

    const mockFd = {
      writeFile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    mockedOpen.mockResolvedValue(mockFd as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("extracted");
  });

  it("certCount reflects number of BEGIN CERTIFICATE blocks", async () => {
    const twoCerts = SAMPLE_PEM + SAMPLE_PEM;
    mockExecFileStdout(twoCerts);
    const mockFd = {
      writeFile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    mockedOpen.mockResolvedValue(mockFd as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.certCount).toBe(2);
  });

  it("execFile returns an error (keychain access error) → { pem: null, source: 'none' } without throwing", async () => {
    mockExecFileError(new Error("security: No matching certificate found"));

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    // must NOT throw
    const result = await ensureCorporateCa();

    expect(result.pem).toBeNull();
    expect(result.source).toBe("none");
  });
});
