import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import {
  createConnectProxy,
  isGlobalAddress,
  parseConnectAuthority,
  validateGlobalAddresses,
} from "./dependency-connect-proxy.mjs";

const allowed = new Set(["registry.npmjs.org", "files.pythonhosted.org"]);

test("accepts exact allowlisted HTTPS CONNECT authorities only", () => {
  assert.deepEqual(parseConnectAuthority("registry.npmjs.org:443", allowed), {
    host: "registry.npmjs.org",
    port: 443,
  });
  for (const target of [
    "registry.npmjs.org:80",
    "REGISTRY.npmjs.org:443",
    "registry.npmjs.org.:443",
    "registry.npmjs.org.evil:443",
    "user@registry.npmjs.org:443",
    "127.0.0.1:443",
    "[::1]:443",
    "files.pythonhosted.org:0443",
  ]) {
    assert.throws(() => parseConnectAuthority(target, allowed));
  }
});

test("rejects private, loopback, link-local, documentation, and non-IP answers", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001::1",
    "2001:20::1",
    "2002::1",
    "3fff::1",
    "not-an-ip",
  ]) {
    assert.equal(isGlobalAddress(address), false, address);
  }
  assert.equal(isGlobalAddress("1.1.1.1"), true);
  assert.equal(isGlobalAddress("2606:4700:4700::1111"), true);
});

test("rejects mixed public and private DNS sets on every resolution", () => {
  assert.deepEqual(validateGlobalAddresses(["1.1.1.1", "2606:4700:4700::1111"]), [
    "1.1.1.1",
    "2606:4700:4700::1111",
  ]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(
      () => validateGlobalAddresses(["1.1.1.1", "169.254.169.254"]),
      /non-global/u,
    );
  }
});

test("re-resolves every CONNECT and dials the validated numeric address", async (context) => {
  let resolutions = 0;
  const dialed = [];
  const proxy = createConnectProxy({
    allowedHosts: new Set(["registry.npmjs.org"]),
    allowedClientIp: "127.0.0.1",
    resolveAddresses: async () => {
      resolutions += 1;
      return resolutions === 1
        ? validateGlobalAddresses(["1.1.1.1"])
        : validateGlobalAddresses(["1.1.1.1", "10.0.0.1"]);
    },
    connectUpstream: (options) => {
      dialed.push(options);
      const stream = new PassThrough();
      queueMicrotask(() => stream.emit("connect"));
      return stream;
    },
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  context.after(() => proxy.close());
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");

  const request = () =>
    new Promise((resolve, reject) => {
      const socket = net.connect(address.port, "127.0.0.1");
      socket.once("connect", () => {
        socket.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n");
      });
      socket.once("data", (data) => {
        resolve(data.toString("ascii"));
        socket.destroy();
      });
      socket.once("error", reject);
    });

  assert.match(await request(), /^HTTP\/1\.1 200 /u);
  assert.match(await request(), /^HTTP\/1\.1 403 /u);
  assert.equal(resolutions, 2);
  assert.deepEqual(dialed, [{
    host: "1.1.1.1",
    port: 443,
    family: 4,
    timeout: 15_000,
  }]);
});

test("denies a client outside the proxy's exact downloader IP", async (context) => {
  let resolved = false;
  const proxy = createConnectProxy({
    allowedHosts: new Set(["registry.npmjs.org"]),
    allowedClientIp: "127.0.0.2",
    resolveAddresses: async () => {
      resolved = true;
      return ["1.1.1.1"];
    },
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  context.after(() => proxy.close());
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(address.port, "127.0.0.1");
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("ascii"));
      socket.destroy();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("proxy client rejection timed out"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write("CONNECT registry.npmjs.org:443 HTTP/1.1\r\n\r\n");
    });
    socket.on("data", (data) => chunks.push(data));
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
  assert.match(response, /^HTTP\/1\.1 403 /u);
  assert.equal(resolved, false);
});
