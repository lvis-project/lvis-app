import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import net from "node:net";

const MAX_HEADER_BYTES = 8 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

function ipv4Number(address) {
  return address
    .split(".")
    .reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inIpv4Range(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isGlobalAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const rejected = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !rejected.some(([base, prefix]) => inIpv4Range(address, base, prefix));
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const first = Number.parseInt(normalized.split(":")[0] || "0", 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  const second = Number.parseInt(normalized.split(":")[1] || "0", 16);
  return !(
    (first === 0x2001 && (second <= 0x01ff || second === 0x0db8))
    || first === 0x2002
    || (first === 0x3fff && second < 0x1000)
  );
}

export function parseConnectAuthority(authority, allowedHosts) {
  if (
    typeof authority !== "string"
    || authority.includes("@")
    || authority.includes("/")
    || authority.includes("\\")
    || authority.includes("%")
  ) {
    throw new Error("CONNECT authority is malformed");
  }
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):([0-9]+)$/u.exec(authority);
  if (!match) throw new Error("CONNECT authority is malformed");
  const host = match[1];
  const port = Number(match[2]);
  if (
    host.endsWith(".")
    || host.includes("..")
    || isIP(host) !== 0
    || match[2] !== "443"
    || port !== 443
    || !allowedHosts.has(host)
  ) {
    throw new Error("CONNECT target is not allowlisted");
  }
  return { host, port };
}

export async function resolveGlobalAddresses(host) {
  const results = await Promise.allSettled([
    resolve4(host),
    resolve6(host),
  ]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []);
  return validateGlobalAddresses(addresses);
}

export function validateGlobalAddresses(addresses) {
  if (addresses.length === 0 || addresses.some((address) => !isGlobalAddress(address))) {
    throw new Error("DNS returned an absent or non-global address");
  }
  return [...new Set(addresses)];
}

function reject(socket, status = "403 Forbidden") {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

export function createConnectProxy({
  allowedHosts,
  allowedClientIp,
  resolveAddresses = resolveGlobalAddresses,
  connectUpstream = net.connect,
}) {
  return net.createServer((client) => {
    const remoteAddress = (client.remoteAddress ?? "").replace(/^::ffff:/u, "");
    if (remoteAddress !== allowedClientIp) {
      reject(client);
      return;
    }
    client.setTimeout(CONNECT_TIMEOUT_MS, () => client.destroy());
    let pending = Buffer.alloc(0);
    const onData = async (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_HEADER_BYTES) {
        reject(client, "431 Request Header Fields Too Large");
        return;
      }
      const boundary = pending.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      client.off("data", onData);
      const header = pending.subarray(0, boundary).toString("ascii");
      const remainder = pending.subarray(boundary + 4);
      const [requestLine, ...headers] = header.split("\r\n");
      if (
        headers.some((line) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+:[\t\x20-\x7e]*$/u.test(line))
      ) {
        reject(client, "400 Bad Request");
        return;
      }
      const request = /^CONNECT ([^\x20]+) HTTP\/1\.[01]$/u.exec(requestLine);
      if (!request) {
        reject(client, "405 Method Not Allowed");
        return;
      }
      try {
        const { host, port } = parseConnectAuthority(request[1], allowedHosts);
        const addresses = await resolveAddresses(host);
        const ipv4Addresses = addresses.filter((address) => isIP(address) === 4);
        const candidates = ipv4Addresses.length > 0 ? ipv4Addresses : addresses;
        const address = candidates[Math.floor(Math.random() * candidates.length)];
        const upstream = connectUpstream({
          host: address,
          port,
          family: isIP(address),
          timeout: CONNECT_TIMEOUT_MS,
        });
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (remainder.length > 0) upstream.write(remainder);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once("timeout", () => upstream.destroy());
        upstream.once("error", () => reject(client, "502 Bad Gateway"));
        client.once("error", () => upstream.destroy());
        client.once("close", () => upstream.destroy());
      } catch {
        reject(client);
      }
    };
    client.on("data", onData);
    client.on("error", () => {});
  });
}

function main() {
  const allowedHosts = new Set(
    (process.env.ALLOWED_HOSTS ?? "")
      .split(",")
      .filter(Boolean),
  );
  const port = Number(process.env.PROXY_PORT ?? "8443");
  const bindAddress = process.env.PROXY_BIND_ADDRESS ?? "";
  const allowedClientIp = process.env.ALLOWED_CLIENT_IP ?? "";
  if (
    allowedHosts.size === 0
    || [...allowedHosts].some((host) => host !== host.toLowerCase())
    || !Number.isInteger(port)
    || port < 1024
    || port > 65535
    || isIP(bindAddress) !== 4
    || isIP(allowedClientIp) !== 4
  ) {
    throw new Error(
      "ALLOWED_HOSTS, ALLOWED_CLIENT_IP, PROXY_BIND_ADDRESS, and a non-privileged PROXY_PORT are required",
    );
  }
  const server = createConnectProxy({ allowedHosts, allowedClientIp });
  server.listen(port, bindAddress, () => {
    process.stdout.write("LVIS_DEPENDENCY_PROXY_READY\n");
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
