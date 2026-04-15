/**
 * corp-ca-loader unit tests — §17 C1
 *
 * child_process.execSync と node:fs を mock して実際の keychain / 파일시스템
 * 없이 모든 경로를 검증한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock node:child_process ──────────────────────────────────────────────────
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// ─── Mock node:fs (sync) — for statSync / readFileSync / mkdirSync ────────────
vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
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

const mockedExecSync = vi.mocked(cpMock.execSync);
const mockedStatSync = vi.mocked(fsMock.statSync);
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
function makeFreshStat(): ReturnType<typeof fsMock.statSync> {
  return { mtimeMs: Date.now() - 1000 } as ReturnType<typeof fsMock.statSync>;
}

function makeStalestat(): ReturnType<typeof fsMock.statSync> {
  // 8 days ago — beyond 7-day TTL
  return { mtimeMs: Date.now() - 8 * 24 * 60 * 60 * 1000 } as ReturnType<typeof fsMock.statSync>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ensureCorporateCa", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: statSync throws ENOENT (no cache)
    mockedStatSync.mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });
    // default: execSync returns empty string
    mockedExecSync.mockReturnValue("" as never);
    // mkdirSync no-op
    mockedMkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("execSync returns empty string → { pem: null, source: 'none' }", async () => {
    mockedExecSync.mockReturnValue("" as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.pem).toBeNull();
    expect(result.source).toBe("none");
    expect(result.certCount).toBe(0);
  });

  it("execSync returns valid PEM → { source: 'extracted' } + cache written", async () => {
    mockedExecSync.mockReturnValue(SAMPLE_PEM as never);

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

  it("cache file fresh (mtime < 7d) → execSync NOT called, source: 'cache'", async () => {
    mockedStatSync.mockReturnValue(makeFreshStat());
    mockedReadFileSync.mockReturnValue(SAMPLE_PEM as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.source).toBe("cache");
    expect(result.pem).toBe(SAMPLE_PEM);
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("cache file stale (mtime > 7d) → re-extracts, source: 'extracted'", async () => {
    mockedStatSync.mockReturnValue(makeStalestat());
    // stale cache content (still valid PEM — but older than 7d)
    mockedReadFileSync.mockReturnValue(SAMPLE_PEM as never);
    // execSync returns fresh PEM
    mockedExecSync.mockReturnValue(SAMPLE_PEM as never);

    const mockFd = {
      writeFile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    mockedOpen.mockResolvedValue(mockFd as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("extracted");
  });

  it("certCount reflects number of BEGIN CERTIFICATE blocks", async () => {
    const twoCerts = SAMPLE_PEM + SAMPLE_PEM;
    mockedExecSync.mockReturnValue(twoCerts as never);
    const mockFd = {
      writeFile: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    mockedOpen.mockResolvedValue(mockFd as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.certCount).toBe(2);
  });

  it("execSync throws (keychain access error) → { pem: null, source: 'none' } without throwing", async () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("security: No matching certificate found");
    });

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    // must NOT throw
    const result = await ensureCorporateCa();

    expect(result.pem).toBeNull();
    expect(result.source).toBe("none");
  });
});
