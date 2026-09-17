import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import {
  OPERATOR_ATTESTATION_AUDIENCE,
  OPERATOR_ATTESTATION_VERSION,
  acquirePublishedOperatorContainerCapability,
  getOperatorContainerCapabilityAuditProjection,
  isIssuedOperatorContainerCapability,
  revalidateOperatorContainerAttestationEvidence,
  verifyOperatorContainerAttestationEvidence,
  type OperatorAttestationIo,
} from "../operator-container-attestation.js";

const NOW = 1_800_000_000;
const TRUST_ROOT = "/etc/lvis/operator-trust.d";
const KEY_PATH = `${TRUST_ROOT}/operator-key.pub`;
const ATTESTATION_PATH = "/run/lvis/operator-attestation.json";
const PROC_ROOT = "/proc/self";
const PROC_IDENTITY = "/proc/4242";
const PROC_SUPER_MAGIC = 0x9fa0n;
const CGROUP2_SUPER_MAGIC = 0x63677270n;
const TMPFS_MAGIC = 0x01021994n;

interface FakeStat {
  uid: number;
  mode: number;
  size: number;
  kind: "file" | "directory";
}

class FakeIo implements OperatorAttestationIo {
  readonly files = new Map<string, Uint8Array>();
  readonly links = new Map<string, string>();
  readonly realpaths = new Map<string, string>();
  readonly stats = new Map<string, FakeStat>();
  readonly openMountIds = new Map<string, string>();
  readonly statfsTypes = new Map<string, bigint>();
  private nextFd = 100;

  private backingPath(path: string): string {
    return path.replace(/^\/proc\/[1-9][0-9]*(?=\/|$)/, PROC_ROOT);
  }

  async openReadOnly(path: string, options?: Readonly<{ directory?: boolean }>) {
    const backing = this.backingPath(path);
    const canonical = this.realpaths.get(path) ?? this.realpaths.get(backing) ?? path;
    const value = this.stats.get(canonical) ?? this.stats.get(path) ?? this.stats.get(backing);
    if (!value || (options?.directory && value.kind !== "directory")) throw new Error("ENOENT");
    const fd = this.nextFd++;
    this.realpaths.set(`${PROC_ROOT}/fd/${fd}`, canonical);
    this.realpaths.set(`${PROC_IDENTITY}/fd/${fd}`, canonical);
    this.setFile(
      `${PROC_ROOT}/fdinfo/${fd}`,
      `pos:\t0\nflags:\t02100000\nmnt_id:\t${this.openMountIds.get(path) ??
        this.openMountIds.get(backing) ??
        (path.startsWith("/sys/fs/cgroup") ? "31" : path.startsWith("/proc") ? "32" : "30")}\n`,
    );
    return {
      fd,
      readFile: async () => {
        const bytes = this.files.get(canonical) ?? this.files.get(path) ?? this.files.get(backing);
        if (!bytes) throw new Error("EISDIR");
        return bytes;
      },
      readUpTo: async (maxBytes: number) => {
        const bytes = this.files.get(canonical) ?? this.files.get(path) ?? this.files.get(backing);
        if (!bytes) throw new Error("EISDIR");
        return bytes.subarray(0, maxBytes);
      },
      stat: async () => ({
        uid: value.uid,
        mode: value.mode,
        size: value.size,
        isFile: () => value.kind === "file",
        isDirectory: () => value.kind === "directory",
      }),
      close: async () => undefined,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path) ?? this.files.get(this.backingPath(path));
    if (!value) throw new Error("ENOENT");
    return value;
  }

  async readlink(path: string): Promise<string> {
    const value = this.links.get(path) ?? this.links.get(this.backingPath(path));
    if (!value) throw new Error("ENOENT");
    return value;
  }

  async realpath(path: string): Promise<string> {
    const value = this.realpaths.get(path) ?? this.realpaths.get(this.backingPath(path));
    if (!value) throw new Error("ENOENT");
    return value;
  }

  async stat(path: string) {
    const value = this.stats.get(path) ?? this.stats.get(this.backingPath(path));
    if (!value) throw new Error("ENOENT");
    return {
      uid: value.uid,
      mode: value.mode,
      size: value.size,
      isFile: () => value.kind === "file",
      isDirectory: () => value.kind === "directory",
    };
  }

  async statfsType(path: string): Promise<bigint> {
    const backing = this.backingPath(path);
    const explicit = this.statfsTypes.get(path) ?? this.statfsTypes.get(backing);
    if (explicit !== undefined) return explicit;
    if (path.startsWith("/proc")) return PROC_SUPER_MAGIC;
    if (path.startsWith("/sys/fs/cgroup")) return CGROUP2_SUPER_MAGIC;
    return TMPFS_MAGIC;
  }

  setFile(path: string, value: string | Uint8Array, mode = 0o100444, uid = 0): void {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    this.files.set(path, bytes);
    this.stats.set(path, { uid, mode, size: bytes.byteLength, kind: "file" });
    this.realpaths.set(path, path);
  }

  setDirectory(path: string, mode = 0o40555, uid = 0): void {
    this.stats.set(path, { uid, mode, size: 0, kind: "directory" });
    this.realpaths.set(path, path);
  }
}

const mountInfo = [
  "29 23 0:25 / / rw,relatime - overlay overlay rw,lowerdir=/lower",
  `30 29 0:26 / ${TRUST_ROOT} ro,nosuid,nodev - tmpfs tmpfs ro`,
  "31 29 0:27 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw",
  "32 29 0:28 / /proc ro,nosuid,nodev,noexec - proc proc ro",
].join("\n");

const normalizedMounts = [
  {
    mountId: "29",
    parentId: "23",
    majorMinor: "0:25",
    root: "/",
    mountPoint: "/",
    mountOptions: ["relatime", "rw"],
    fsType: "overlay",
    mountSource: "overlay",
    superOptions: ["lowerdir=/lower", "rw"],
    optionalFields: [],
  },
  {
    mountId: "30",
    parentId: "29",
    majorMinor: "0:26",
    root: "/",
    mountPoint: TRUST_ROOT,
    mountOptions: ["nodev", "nosuid", "ro"],
    fsType: "tmpfs",
    mountSource: "tmpfs",
    superOptions: ["ro"],
    optionalFields: [],
  },
  {
    mountId: "32",
    parentId: "29",
    majorMinor: "0:28",
    root: "/",
    mountPoint: "/proc",
    mountOptions: ["nodev", "noexec", "nosuid", "ro"],
    fsType: "proc",
    mountSource: "proc",
    superOptions: ["ro"],
    optionalFields: [],
  },
  {
    mountId: "31",
    parentId: "29",
    majorMinor: "0:27",
    root: "/",
    mountPoint: "/sys/fs/cgroup",
    mountOptions: ["nodev", "noexec", "nosuid", "relatime", "ro"],
    fsType: "cgroup2",
    mountSource: "cgroup",
    superOptions: ["rw"],
    optionalFields: [],
  },
];

function validClaims() {
  return {
    isolation: {
      disposable: true,
      noHostMounts: true,
      noHostNamespaces: true,
      noInheritedSecrets: true,
    },
    namespaces: {
      mnt: "mnt:[4001]",
      pid: "pid:[4002]",
      net: "net:[4003]",
      ipc: "ipc:[4004]",
      uts: "uts:[4005]",
      cgroup: "cgroup:[4006]",
      user: "user:[4007]",
    },
    cgroup: {
      version: 2,
      path: "/lvis/run-7",
      limits: {
        memoryMaxBytes: "2147483648",
        pidsMax: "256",
        cpuQuotaMicros: "200000",
        cpuPeriodMicros: "100000",
      },
    },
    mountInfo: {
      sha256: sha256Hex(canonicalStringify(normalizedMounts)),
      rootMount: {
        majorMinor: "0:25",
        root: "/",
        mountPoint: "/",
        mountOptions: ["relatime", "rw"],
        fsType: "overlay",
        mountSource: "overlay",
        superOptions: ["lowerdir=/lower", "rw"],
      },
    },
    process: {
      bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      pid: "4242",
      startTimeTicks: "123456",
      uidMap: "0 0 4294967295",
      gidMap: "0 0 4294967295",
      uids: ["1000", "1000", "1000", "1000"],
      noNewPrivs: true,
      seccomp: 2,
      capInh: "0000000000000000",
      capPrm: "0000000000000000",
      capEff: "0000000000000000",
      capBnd: "0000000000000000",
      capAmb: "0000000000000000",
    },
  } as const;
}

function fixture() {
  const io = new FakeIo();
  let now = NOW;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ format: "pem", type: "spki" });
  io.setDirectory(TRUST_ROOT);
  io.setFile(KEY_PATH, publicPem);
  io.realpaths.set(PROC_ROOT, PROC_IDENTITY);
  io.setFile(`${PROC_ROOT}/mountinfo`, mountInfo);
  io.setFile(`${PROC_ROOT}/cgroup`, "0::/lvis/run-7\n");
  io.setFile(`${PROC_ROOT}/stat`, [
    "4242 (lvis worker) S",
    ...Array(18).fill("0"),
    "123456",
    ...Array(10).fill("0"),
  ].join(" "));
  io.setFile(`${PROC_ROOT}/uid_map`, "         0          0 4294967295\n");
  io.setFile(`${PROC_ROOT}/gid_map`, "         0          0 4294967295\n");
  io.setFile("/proc/sys/kernel/random/boot_id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n");
  io.setFile(`${PROC_ROOT}/status`, [
    "Name:\tlvis",
    "Uid:\t1000\t1000\t1000\t1000",
    "NoNewPrivs:\t1",
    "Seccomp:\t2",
    "CapInh:\t0000000000000000",
    "CapPrm:\t0000000000000000",
    "CapEff:\t0000000000000000",
    "CapBnd:\t0000000000000000",
    "CapAmb:\t0000000000000000",
  ].join("\n"));
  const namespaces = validClaims().namespaces;
  for (const name of Object.keys(namespaces) as Array<keyof typeof namespaces>) {
    io.links.set(`${PROC_ROOT}/ns/${name}`, namespaces[name]);
  }
  io.setFile("/sys/fs/cgroup/lvis/run-7/memory.max", "2147483648\n");
  io.setFile("/sys/fs/cgroup/lvis/run-7/pids.max", "256\n");
  io.setFile("/sys/fs/cgroup/lvis/run-7/cpu.max", "200000 100000\n");
  io.setDirectory("/sys/fs/cgroup/lvis/run-7");

  const writeAttestation = (overrides: Record<string, unknown> = {}) => {
    const payload = {
      version: OPERATOR_ATTESTATION_VERSION,
      audience: OPERATOR_ATTESTATION_AUDIENCE,
      keyId: "operator-key",
      issuedAt: NOW,
      notBefore: NOW - 5,
      expiresAt: NOW + 120,
      claims: validClaims(),
      ...overrides,
    };
    const signature = sign(null, Buffer.from(canonicalStringify(payload)), privateKey)
      .toString("base64");
    io.setFile(ATTESTATION_PATH, JSON.stringify({ ...payload, signature }), 0o100600, 1000);
    return { payload, signature };
  };
  writeAttestation();
  return {
    io,
    setNow: (value: number) => { now = value; },
    writeAttestation,
    deps: {
      platform: "linux" as const,
      trustRoot: TRUST_ROOT,
      procRoot: PROC_ROOT,
      now: () => now,
      io,
    },
  };
}

describe("operator container attestation", () => {
  it("publishes no authority when production verification has not run", async () => {
    await expect(acquirePublishedOperatorContainerCapability()).resolves.toBeNull();
  });

  it("returns immutable audit-safe evidence without issuing host authority", async () => {
    const f = fixture();
    const evidence = await verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps);
    expect(isIssuedOperatorContainerCapability(evidence)).toBe(false);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.fingerprints)).toBe(true);
    expect(evidence.expiresAt).toBe(NOW + 120);
    expect(evidence.fingerprints.attestation).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.isolation).toEqual(validClaims().isolation);
    expect(evidence.limits).toEqual(validClaims().cgroup.limits);
    expect(JSON.stringify(evidence)).not.toContain("BEGIN PUBLIC KEY");
    expect(JSON.stringify(evidence)).not.toContain("mountSource");
    expect(JSON.stringify(evidence)).not.toContain("signature");
    expect(JSON.stringify(evidence)).not.toContain("/lvis/run-7");
    expect(JSON.stringify(evidence)).not.toContain("mnt:[4001]");
    expect(JSON.stringify(evidence)).not.toContain("user:[4007]");
  });

  it("does not accept a structurally similar object as host-issued evidence", async () => {
    const f = fixture();
    const evidence = await verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps);
    const forged = JSON.parse(JSON.stringify(evidence));
    expect(isIssuedOperatorContainerCapability(forged)).toBe(false);
    expect(() => getOperatorContainerCapabilityAuditProjection(forged))
      .toThrow("capability-not-issued");
  });

  it("revalidates process identity before non-authoritative evidence is reused", async () => {
    const f = fixture();
    const evidence = await verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps);
    expect(await revalidateOperatorContainerAttestationEvidence(evidence)).toBe(evidence);
    f.io.links.set(`${PROC_ROOT}/ns/pid`, "pid:[9999]");
    await expect(revalidateOperatorContainerAttestationEvidence(evidence))
      .rejects.toThrow("attestation-evidence-process-changed");
  });

  it("expires issued evidence before it can be reused", async () => {
    const f = fixture();
    const evidence = await verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps);
    f.setNow(NOW + 120);
    await expect(revalidateOperatorContainerAttestationEvidence(evidence))
      .rejects.toThrow("attestation-evidence-expired");
  });

  it("rejects evidence that expires while process facts are being revalidated", async () => {
    const f = fixture();
    const evidence = await verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps);
    const originalRealpath = f.io.realpath.bind(f.io);
    f.io.realpath = async (path: string) => {
      const result = await originalRealpath(path);
      f.setNow(NOW + 120);
      return result;
    };
    await expect(revalidateOperatorContainerAttestationEvidence(evidence))
      .rejects.toThrow("attestation-evidence-expired");
  });

  it("rejects an attestation that expires while verification is in progress", async () => {
    const f = fixture();
    let clockReads = 0;
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, {
      ...f.deps,
      now: () => clockReads++ === 0 ? NOW : NOW + 120,
    })).rejects.toThrow("attestation-expired-during-verification");
  });

  it.each(["darwin", "win32"] as const)("fails closed on %s", async (platform) => {
    const f = fixture();
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, {
      ...f.deps,
      platform,
    })).rejects.toThrow("platform-unsupported");
  });

  it("requires a canonical absolute attestation path", async () => {
    const f = fixture();
    await expect(verifyOperatorContainerAttestationEvidence("relative.json", f.deps))
      .rejects.toThrow("attestation-path-invalid");
    await expect(verifyOperatorContainerAttestationEvidence("/run/lvis/../operator.json", f.deps))
      .rejects.toThrow("attestation-path-invalid");
  });

  it("rejects duplicate members, unknown fields, and an embedded public key", async () => {
    const f = fixture();
    const current = f.writeAttestation();
    f.io.setFile(
      ATTESTATION_PATH,
      `{"version":"${OPERATOR_ATTESTATION_VERSION}",` +
        `"version":"${OPERATOR_ATTESTATION_VERSION}"}`,
    );
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("json-invalid");
    f.writeAttestation({ extra: true });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("document-fields-invalid");
    f.writeAttestation({ publicKey: "not-authority" });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("document-fields-invalid");
    expect(current.signature).toBeTruthy();
  });

  it("rejects an oversized document before reading it", async () => {
    const f = fixture();
    f.io.stats.set(ATTESTATION_PATH, {
      uid: 1000,
      mode: 0o100600,
      size: 64 * 1_024 + 1,
      kind: "file",
    });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("attestation-file-invalid");
  });

  it("bounds the descriptor read even if file metadata understates its size", async () => {
    const f = fixture();
    f.io.setFile(ATTESTATION_PATH, "x".repeat(64 * 1_024 + 1));
    f.io.stats.set(ATTESTATION_PATH, {
      uid: 1000,
      mode: 0o100600,
      size: 1,
      kind: "file",
    });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("attestation-size-invalid");
  });

  it.each([
    [{ audience: "another-service" }, "audience-invalid"],
    [{ version: "operator-attestation/v0" }, "version-invalid"],
    [{ notBefore: NOW + 1 }, "time-window-invalid"],
    [{ notBefore: NOW - 1_000, issuedAt: NOW - 900 }, "time-window-invalid"],
    [{ expiresAt: NOW }, "attestation-not-current"],
    [{ keyId: "../key" }, "key-id-invalid"],
  ] as const)("rejects invalid signed metadata %j", async (overrides, code) => {
    const f = fixture();
    f.writeAttestation(overrides);
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow(code);
  });

  it("rejects a signature not made by the named system key", async () => {
    const f = fixture();
    const other = generateKeyPairSync("ed25519");
    const payload = f.writeAttestation().payload;
    const signature = sign(null, Buffer.from(canonicalStringify(payload)), other.privateKey)
      .toString("base64");
    f.io.setFile(ATTESTATION_PATH, JSON.stringify({ ...payload, signature }), 0o100600, 1000);
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("signature-invalid");
  });

  it("verifies a fixed Ed25519 canonicalization vector", async () => {
    const f = fixture();
    // Generated once with an independent recursive key sorter; the private key
    // is intentionally absent so this test cannot regenerate its own answer.
    const publicPem = [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAfZcXu1W8Yxry4BDzsexlUEqX8JXInL1Va2TThkN3pF4=",
      "-----END PUBLIC KEY-----",
      "",
    ].join("\n");
    const payload = {
      version: OPERATOR_ATTESTATION_VERSION,
      audience: OPERATOR_ATTESTATION_AUDIENCE,
      keyId: "operator-key",
      issuedAt: 1_800_000_000,
      notBefore: 1_799_999_995,
      expiresAt: 1_800_000_120,
      claims: validClaims(),
    };
    const signature =
      "Zyc4LaYqHmEyDO0O6khc+XLI2OvuUsX/GAsVDBYnyy5xc8rDYaWcq5TTWLhmQGjMlvyxc/ldv7+L13F+1yi4AA==";
    expect(payload.claims.mountInfo.sha256).toBe(
      "f5337702932d9723aff35af9bee6f6c862a0124925836b67c890342206c980d9",
    );
    f.io.setFile(KEY_PATH, publicPem);
    f.io.setFile(
      ATTESTATION_PATH,
      JSON.stringify({ ...payload, signature }),
      0o100600,
      1000,
    );
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .resolves.toMatchObject({ expiresAt: NOW + 120 });
  });

  it.each([
    ["trust root is writable", (f: ReturnType<typeof fixture>) => {
      f.io.stats.set(TRUST_ROOT, { uid: 0, mode: 0o40775, size: 0, kind: "directory" });
    }, "trust-root-ownership-invalid"],
    ["trust mount is writable", (f: ReturnType<typeof fixture>) => {
      f.io.setFile(`${PROC_ROOT}/mountinfo`, mountInfo.replace(
        `${TRUST_ROOT} ro,nosuid,nodev`,
        `${TRUST_ROOT} rw,nosuid,nodev`,
      ));
    }, "trust-root-mount-not-read-only"],
    ["key is writable", (f: ReturnType<typeof fixture>) => {
      const current = f.io.stats.get(KEY_PATH)!;
      f.io.stats.set(KEY_PATH, { ...current, mode: 0o100644 });
    }, "trusted-key-metadata-invalid"],
    ["key is not root owned", (f: ReturnType<typeof fixture>) => {
      const current = f.io.stats.get(KEY_PATH)!;
      f.io.stats.set(KEY_PATH, { ...current, uid: 1000 });
    }, "trusted-key-metadata-invalid"],
    ["cgroup mount is writable", (f: ReturnType<typeof fixture>) => {
      f.io.setFile(`${PROC_ROOT}/mountinfo`, mountInfo.replace(
        "/sys/fs/cgroup ro,nosuid,nodev,noexec,relatime",
        "/sys/fs/cgroup rw,nosuid,nodev,noexec,relatime",
      ));
    }, "cgroup-v2-mount-not-read-only"],
    ["a process status file is hidden by a non-proc mount", (f: ReturnType<typeof fixture>) => {
      const statusPath = `${PROC_IDENTITY}/status`;
      f.io.setFile(`${PROC_ROOT}/mountinfo`, `${mountInfo}\n` +
        `33 32 0:29 / ${statusPath} ro - tmpfs tmpfs ro`);
      f.io.openMountIds.set(statusPath, "33");
      f.io.statfsTypes.set(statusPath, TMPFS_MAGIC);
    }, "process-status-read-failed-filesystem-invalid"],
    ["mountinfo claims procfs while the kernel reports tmpfs", (f: ReturnType<typeof fixture>) => {
      f.io.statfsTypes.set(`${PROC_IDENTITY}/mountinfo`, TMPFS_MAGIC);
    }, "mount-info-filesystem-invalid"],
    ["the descriptor mount observation is replaced by a nested proc bind", (f: ReturnType<typeof fixture>) => {
      f.io.setFile(`${PROC_ROOT}/mountinfo`, `${mountInfo}\n` +
        `33 32 0:28 /123/fdinfo ${PROC_IDENTITY}/fdinfo ro - proc proc ro`);
    }, "fdinfo-mount-invalid"],
    ["a namespace entry is replaced by a nested proc bind", (f: ReturnType<typeof fixture>) => {
      f.io.setFile(`${PROC_ROOT}/mountinfo`, `${mountInfo}\n` +
        `33 32 0:28 /123/ns/mnt ${PROC_IDENTITY}/ns/mnt ro - proc proc ro`);
    }, "namespace-mnt-mount-invalid"],
    ["the user namespace uses a rootless identity map", (f: ReturnType<typeof fixture>) => {
      f.io.setFile(`${PROC_ROOT}/uid_map`, "0 1000 1\n");
    }, "process-uid-map-not-host-identity"],
    ["a cgroup limit is hidden by a nested mount", (f: ReturnType<typeof fixture>) => {
      const limitPath = "/sys/fs/cgroup/lvis/run-7/memory.max";
      f.io.setFile(`${PROC_ROOT}/mountinfo`, `${mountInfo}\n` +
        `33 31 0:29 / ${limitPath} ro - tmpfs tmpfs ro`);
      f.io.openMountIds.set(limitPath, "33");
    }, "memory-limit-read-failed-mount-invalid"],
    ["key is hidden by a nested mount", (f: ReturnType<typeof fixture>) => {
      f.io.setFile(`${PROC_ROOT}/mountinfo`, `${mountInfo}\n` +
        `34 30 0:30 / ${KEY_PATH} rw - tmpfs tmpfs rw`);
      f.io.openMountIds.set(KEY_PATH, "34");
    }, "trusted-key-mount-invalid"],
    ["key resolves outside root", (f: ReturnType<typeof fixture>) => {
      f.io.realpaths.set(KEY_PATH, "/run/untrusted.pub");
      f.io.stats.set("/run/untrusted.pub", { uid: 0, mode: 0o100444, size: 32, kind: "file" });
    }, "trusted-key-outside-root"],
  ] as const)("rejects when %s", async (_label, mutate, code) => {
    const f = fixture();
    mutate(f);
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow(code);
  });

  it("rejects dangerous capabilities retained in any process set", async () => {
    const f = fixture();
    f.io.setFile(`${PROC_ROOT}/status`, [
      "NoNewPrivs:\t1",
      "Seccomp:\t2",
      "Uid:\t1000\t1000\t1000\t1000",
      "CapInh:\t0000000000000000",
      "CapPrm:\t0000000000200000",
      "CapEff:\t0000000000000000",
      "CapBnd:\t0000000000000000",
      "CapAmb:\t0000000000000000",
    ].join("\n"));
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("dangerous-process-capability-present");
  });

  it("allows capability bits outside the explicit dangerous set", async () => {
    const f = fixture();
    f.io.setFile(`${PROC_ROOT}/status`, [
      "NoNewPrivs:\t1",
      "Seccomp:\t2",
      "Uid:\t1000\t1000\t1000\t1000",
      "CapInh:\t0000000000000000",
      "CapPrm:\t0000000000000000",
      "CapEff:\t0000000000000400",
      "CapBnd:\t0000000000000000",
      "CapAmb:\t0000000000000000",
    ].join("\n"));
    const claims = validClaims();
    f.writeAttestation({
      claims: {
        ...claims,
        process: { ...claims.process, capEff: "0000000000000400" },
      },
    });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .resolves.toMatchObject({ expiresAt: NOW + 120 });
  });

  it.each([
    "0\t1000\t1000\t1000",
    "1000\t0\t1000\t1000",
    "1000\t1000\t0\t1000",
    "1000\t1000\t1000\t0",
  ])("rejects root identity in any UID slot: %s", async (uids) => {
    const f = fixture();
    f.io.setFile(`${PROC_ROOT}/status`, [
      "NoNewPrivs:\t1",
      "Seccomp:\t2",
      `Uid:\t${uids}`,
      "CapInh:\t0000000000000000",
      "CapPrm:\t0000000000000000",
      "CapEff:\t0000000000000000",
      "CapBnd:\t0000000000000000",
      "CapAmb:\t0000000000000000",
    ].join("\n"));
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("process-root-uid-not-allowed");
  });

  it("rejects ambiguous root mount tuples", async () => {
    const f = fixture();
    f.io.setFile(`${PROC_ROOT}/mountinfo`, `${mountInfo}\n` +
      "33 23 0:29 / / rw - tmpfs tmpfs rw");
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("root-mount-ambiguous");
  });

  it.each([
    ["memory.max", "max\n", "memory-limit-unbounded"],
    ["pids.max", "max\n", "pids-limit-unbounded"],
    ["cpu.max", "max 100000\n", "cpu-limit-unbounded"],
  ] as const)("rejects an unbounded %s", async (file, value, code) => {
    const f = fixture();
    f.io.setFile(`/sys/fs/cgroup/lvis/run-7/${file}`, value);
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow(code);
  });

  it("maps namespace-relative cgroup membership onto a host-prefixed mount root", async () => {
    const f = fixture();
    const namespacedMountInfo = mountInfo.replace(
      "31 29 0:27 / /sys/fs/cgroup",
      "31 29 0:27 /host.slice/container.scope /sys/fs/cgroup",
    );
    f.io.setFile(`${PROC_ROOT}/mountinfo`, namespacedMountInfo);
    f.io.setFile(`${PROC_ROOT}/cgroup`, "0::/\n");
    f.io.setDirectory("/sys/fs/cgroup");
    f.io.setFile("/sys/fs/cgroup/memory.max", "2147483648\n");
    f.io.setFile("/sys/fs/cgroup/pids.max", "256\n");
    f.io.setFile("/sys/fs/cgroup/cpu.max", "200000 100000\n");
    const claims = validClaims();
    const namespacedMounts = normalizedMounts.map((mount) =>
      mount.mountId === "31" ? { ...mount, root: "/host.slice/container.scope" } : mount);
    f.writeAttestation({
      claims: {
        ...claims,
        cgroup: { ...claims.cgroup, path: "/" },
        mountInfo: {
          ...claims.mountInfo,
          sha256: sha256Hex(canonicalStringify(namespacedMounts)),
        },
      },
    });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .resolves.toMatchObject({ expiresAt: NOW + 120 });
  });

  it("rejects signed claims that do not match the current process", async () => {
    const f = fixture();
    const claims = validClaims();
    f.writeAttestation({
      claims: {
        ...claims,
        cgroup: { ...claims.cgroup, path: "/lvis/another-run" },
      },
    });
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("process-facts-mismatch");
  });

  it("rejects replay against another process instance in the same container", async () => {
    const f = fixture();
    f.io.realpaths.set(PROC_ROOT, "/proc/4343");
    f.io.setFile(`${PROC_ROOT}/stat`, [
      "4343 (lvis worker) S",
      ...Array(18).fill("0"),
      "987654",
      ...Array(10).fill("0"),
    ].join(" "));
    await expect(verifyOperatorContainerAttestationEvidence(ATTESTATION_PATH, f.deps))
      .rejects.toThrow("process-facts-mismatch");
  });
});
