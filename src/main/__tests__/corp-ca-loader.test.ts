/**
 * corp-ca-loader unit tests — §17 C1
 *
 * child_process.execFile 와 node:fs 를 mock 해서 실제 keychain / 파일시스템
 * 없이 모든 경로를 검증한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock node:child_process ──────────────────────────────────────────────────
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
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

const mockedExecFile = vi.mocked(cpMock.execFile);
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
    delete process.env.LVIS_CORP_CA_CN;
    // Mock process.platform to 'darwin' so extractByPlatform() calls extractMacos()
    // which invokes execSync — required for extraction tests to pass on Linux CI.
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true, writable: true });
    // default: statSync throws ENOENT (no cache)
    mockedStatSync.mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });
    // default: execFile returns empty string
    mockExecFileStdout("");
    // mkdirSync no-op
    mockedMkdirSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env.LVIS_CORP_CA_CN;
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
    mockedStatSync.mockReturnValue(makeFreshStat());
    mockedReadFileSync.mockReturnValue(SAMPLE_PEM as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.source).toBe("cache");
    expect(result.pem).toBe(SAMPLE_PEM);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it("cache file stale (mtime > 7d) → re-extracts, source: 'extracted'", async () => {
    mockedStatSync.mockReturnValue(makeStalestat());
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

  it("macOS tries fallback corporate CA hints in order", async () => {
    mockedExecFile.mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (err: Error | null, stdout: string, stderr: string) => void;
      const requestedCn = (args[1] as string[])[3];
      if (requestedCn === "Corporate Root CA") {
        callback(null, "", "");
      } else if (requestedCn === "LGERootCA") {
        callback(null, SAMPLE_PEM, "");
      } else {
        callback(new Error(`unexpected CN ${requestedCn}`), "", "");
      }
      return {} as ReturnType<typeof cpMock.execFile>;
    }) as never);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.pem).toBe(SAMPLE_PEM);
    expect(result.source).toBe("extracted");
    expect(mockedExecFile).toHaveBeenCalledTimes(2);
  });

  it("Windows exports trusted root store PEM via PowerShell", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: true });
    mockExecFileStdout(SAMPLE_PEM);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    const result = await ensureCorporateCa();

    expect(result.pem).toBe(SAMPLE_PEM);
    expect(result.source).toBe("extracted");
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    const [command, args] = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-EncodedCommand");
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("Location = 'LocalMachine'");
    expect(script).toContain("Location = 'CurrentUser'");
    expect(script).toContain("Name = 'CA'");
    expect(script).toContain("$cert.NotAfter -le $now");
    expect(script).toContain("$issuer = [string]$cert.Issuer");
    expect(script).toContain("'Corporate Root CA'");
    expect(script).toContain("'LGERootCA'");
  });

  it("Windows honors LVIS_CORP_CA_CN subject filters", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true, writable: true });
    process.env.LVIS_CORP_CA_CN = "LGERootCA; LG Issuing";
    mockExecFileStdout(SAMPLE_PEM);

    const { ensureCorporateCa } = await import("../corp-ca-loader.js");
    await ensureCorporateCa();

    const [, args] = mockedExecFile.mock.calls[0] as unknown as [string, string[]];
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("'LGERootCA'");
    expect(script).toContain("'LG Issuing'");
  });
});
