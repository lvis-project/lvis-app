import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
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

const markerPort = Number.parseInt(process.env.HOST_MARKER_PORT ?? "", 10);
if (
  !Number.isSafeInteger(markerPort) ||
  markerPort < 1024 ||
  markerPort > 65_535 ||
  String(markerPort) !== process.env.HOST_MARKER_PORT
) {
  throw new Error("HOST_MARKER_PORT is not a validated unprivileged TCP port");
}

const routeLines = (await readFile("/proc/net/route", "utf8"))
  .trim()
  .split("\n")
  .slice(1);

function routeHexToIpv4(hex, label) {
  if (!/^[0-9A-Fa-f]{8}$/u.test(hex)) {
    throw new Error(`${label} is not an eight-digit hexadecimal IPv4 value`);
  }
  return hex
    .match(/../gu)
    .reverse()
    .map((octet) => Number.parseInt(octet, 16))
    .join(".");
}

function ipv4ToUint(address) {
  if (!net.isIPv4(address))
    throw new Error(`route contains invalid IPv4 address: ${address}`);
  return address
    .split(".")
    .reduce(
      (value, octet) => ((value << 8) | Number.parseInt(octet, 10)) >>> 0,
      0,
    );
}

function uintToIpv4(value) {
  return [
    value >>> 24,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

const defaultRoutes = routeLines.filter((line) => {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 8 || fields[1] !== "00000000") return false;
  const flags = Number.parseInt(fields[3], 16);
  return Number.isSafeInteger(flags) && (flags & 0x1) === 0x1;
});
if (defaultRoutes.length !== 0) {
  throw new Error(
    `isolated network exposed ${defaultRoutes.length} active default route(s)`,
  );
}

const connectedRoutes = routeLines.flatMap((line) => {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 8 || fields[1] === "00000000" || fields[2] !== "00000000")
    return [];
  const flags = Number.parseInt(fields[3], 16);
  if (!Number.isSafeInteger(flags) || (flags & 0x1) !== 0x1) return [];
  const destination = routeHexToIpv4(fields[1], "connected route destination");
  const mask = routeHexToIpv4(fields[7], "connected route mask");
  const destinationUint = ipv4ToUint(destination);
  const maskUint = ipv4ToUint(mask);
  const invertedMask = ~maskUint >>> 0;
  if (
    invertedMask < 3 ||
    invertedMask === 0xffffffff ||
    (invertedMask & ((invertedMask + 1) >>> 0)) !== 0 ||
    (destinationUint & maskUint) !== destinationUint
  ) {
    throw new Error(
      `connected route has an unsafe subnet: ${destination}/${mask}`,
    );
  }
  const bridgeGateway = uintToIpv4((destinationUint + 1) >>> 0);
  return [{ bridgeGateway, interface: fields[0] }];
});
if (connectedRoutes.length !== 1) {
  throw new Error(
    `expected exactly one active connected route, found ${connectedRoutes.length}`,
  );
}
const [{ bridgeGateway, interface: connectedInterface }] = connectedRoutes;
if (!/^[A-Za-z0-9_.-]+$/u.test(connectedInterface)) {
  throw new Error("connected route interface contains unexpected characters");
}

let externalDnsBlocked = false;
try {
  await lookup(`lvis-e2e-dns-${process.pid}-${Date.now()}.invalid`, { all: true });
} catch {
  externalDnsBlocked = true;
}
if (!externalDnsBlocked) throw new Error("external DNS resolution is available");

let publicDnsBlocked = false;
try {
  await lookup("example.com", { all: true });
} catch {
  publicDnsBlocked = true;
}
if (!publicDnsBlocked) throw new Error("known public DNS resolution is available");

async function expectTcpBlocked({ host, port, label }) {
  const blocked = await new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_500, () => finish(true));
    socket.once("error", () => finish(true));
    socket.once("connect", () => finish(false));
  });
  if (!blocked) throw new Error(`${label} is reachable at ${host}:${port}`);
}

await Promise.all([
  expectTcpBlocked({
    host: bridgeGateway,
    port: markerPort,
    label: "trusted host-gateway marker",
  }),
  expectTcpBlocked({
    host: "1.1.1.1",
    port: 443,
    label: "public Internet target",
  }),
  expectTcpBlocked({
    host: "10.255.255.1",
    port: 443,
    label: "RFC1918 10/8 target",
  }),
  expectTcpBlocked({
    host: "172.16.255.254",
    port: 443,
    label: "RFC1918 172.16/12 target",
  }),
  expectTcpBlocked({
    host: "192.168.255.254",
    port: 443,
    label: "RFC1918 192.168/16 target",
  }),
  expectTcpBlocked({
    host: "169.254.169.254",
    port: 80,
    label: "link-local metadata target",
  }),
]);

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
    defaultRouteAbsent: true,
    connectedRouteInterface: connectedInterface,
    hostGatewayMarkerBlocked: true,
    externalDnsBlocked,
    publicDnsBlocked,
    externalEgressBlocked: true,
    rfc1918EgressBlocked: true,
    linkLocalEgressBlocked: true,
  }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
