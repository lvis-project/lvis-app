import { spawn } from "node:child_process";
import {
  access,
  lstat,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import process from "node:process";

if (process.getuid?.() !== 10002) {
  throw new Error("hostile containment rehearsal must run as the isolated hostile UID");
}

const capLine = (await readFile("/proc/self/status", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("CapEff:"));
if (!capLine || !/^CapEff:\s+0+$/u.test(capLine)) {
  throw new Error(`effective capabilities are not empty: ${capLine ?? "missing"}`);
}

const absentEnvironment = [
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_TOKEN",
  "M4_MARKETPLACE_CHECKOUT_TOKEN",
  "PRIVATE_API_TOKEN",
];
for (const name of absentEnvironment) {
  if (Object.hasOwn(process.env, name)) {
    throw new Error(`secret or GitHub environment variable is present: ${name}`);
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return false;
    throw error;
  }
}

const forbiddenPaths = [
  "/var/run/docker.sock",
  "/workspace",
  "/candidate/marketplace",
  "/candidate/ep",
  "/candidate/sdk",
  "/private-sources",
];
for (const forbidden of forbiddenPaths) {
  if (await pathExists(forbidden)) {
    throw new Error(`forbidden path is visible: ${forbidden}`);
  }
}

async function expectWriteFailure(path) {
  try {
    await writeFile(path, "must fail", { flag: "wx", mode: 0o600 });
  } catch {
    return;
  }
  throw new Error(`hostile write unexpectedly succeeded: ${path}`);
}

for (const path of [
  "/candidate/app/.hostile-root-write",
  "/trusted/control/.hostile-control-write",
  "/workspace/.hostile-sibling-write",
  "/host-marker",
]) {
  await expectWriteFailure(path);
}

for (const name of [
  "input-bindings.json",
  "control-harness-manifest.json",
  "image-digests.json",
  "input-contract.json",
]) {
  const path = `/evidence/${name}`;
  await access(path);
  try {
    await writeFile(path, "tamper", { flag: "a" });
    throw new Error(`hostile mutation unexpectedly succeeded: ${name}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("hostile mutation")) throw error;
  }
  try {
    await unlink(path);
    throw new Error(`hostile unlink unexpectedly succeeded: ${name}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("hostile unlink")) throw error;
  }
}

const sudoDenied = await new Promise((resolve, reject) => {
  const child = spawn("sudo", ["-n", "true"], {
    shell: false,
    stdio: "ignore",
  });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  child.once("error", (error) => {
    if (error?.code === "ENOENT" || error?.code === "EACCES") finish(true);
    else reject(error);
  });
  child.once("exit", (code, signal) => finish(code !== 0 || signal != null));
});
if (!sudoDenied) throw new Error("passwordless sudo unexpectedly succeeded");

const internalHealth = await fetch("http://marketplace:8765/api/v1/health");
if (!internalHealth.ok) throw new Error("internal Marketplace network is unreachable");

const externalEgressBlocked = await new Promise((resolve) => {
  const socket = net.connect({ host: "1.1.1.1", port: 443 });
  let settled = false;
  const finish = (blocked) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(blocked);
  };
  socket.setTimeout(1_500, () => finish(true));
  socket.once("error", () => finish(true));
  socket.once("connect", () => finish(false));
});
if (!externalEgressBlocked) throw new Error("external network egress is available");

await writeFile(
  "/evidence/hostile-containment.json",
  `${JSON.stringify({
    uid: process.getuid?.(),
    effectiveCapabilities: "0",
    rootReadOnly: true,
    dockerSocketVisible: await pathExists("/var/run/docker.sock"),
    siblingSourcesVisible: false,
    sensitiveEnvironmentAbsent: true,
    passwordlessSudoDenied: sudoDenied,
    trustedControlWriteBlocked: true,
    siblingWriteBlocked: true,
    hostMarkerWriteBlocked: true,
    sealedInputMutationBlocked: true,
    internalMarketplaceReachable: true,
    externalEgressBlocked: true,
  }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
