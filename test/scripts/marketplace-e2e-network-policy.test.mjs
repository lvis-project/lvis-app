import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const orchestratePath = new URL(
  "../control/marketplace-e2e/orchestrate.sh",
  import.meta.url,
);
const hostilePath = new URL(
  "../control/marketplace-e2e/run-hostile.mjs",
  import.meta.url,
);
const orchestrate = readFileSync(orchestratePath, "utf8");
const hostile = readFileSync(hostilePath, "utf8");

function assertIsolatedNetworkPolicy(source) {
  for (const required of [
    "docker network create --internal",
    "--driver bridge",
    "--ipv6=false",
    '--subnet "$network_subnet"',
    '--gateway "$network_gateway"',
    "-o com.docker.network.bridge.gateway_mode_ipv4=isolated",
    'docker network inspect "$network"',
    '.Driver == "bridge"',
    ".Internal == true",
    ".EnableIPv6 == false",
    ".Attachable == false",
    ".Ingress == false",
    '.Options == {\n      "com.docker.network.bridge.gateway_mode_ipv4": "isolated"\n    }',
    '"Config": [{"Subnet": $subnet, "Gateway": $gateway}]',
    ".Containers == {}",
  ]) {
    assert.ok(
      source.includes(required),
      `missing fail-closed network policy: ${required}`,
    );
  }
}

test("creates and inspects a fail-closed isolated IPv4 bridge", () => {
  assertIsolatedNetworkPolicy(orchestrate);
  assert.match(orchestrate, /--ip "\$marketplace_ip"/u);
  assert.match(orchestrate, /observed_marketplace_ip.*marketplace_ip/su);
});

test("rejects missing or weakened create and inspect isolation policies", () => {
  const missing = orchestrate.replace(
    "  -o com.docker.network.bridge.gateway_mode_ipv4=isolated \\\n",
    "",
  );
  assert.throws(
    () => assertIsolatedNetworkPolicy(missing),
    /gateway_mode_ipv4=isolated/u,
  );

  const wrong = orchestrate.replace(
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    "com.docker.network.bridge.gateway_mode_ipv4=nat",
  );
  assert.throws(
    () => assertIsolatedNetworkPolicy(wrong),
    /gateway_mode_ipv4=isolated/u,
  );

  const wrongInspectionOption = orchestrate.replace(
    '"com.docker.network.bridge.gateway_mode_ipv4": "isolated"',
    '"com.docker.network.bridge.gateway_mode_ipv4": "nat"',
  );
  assert.throws(
    () => assertIsolatedNetworkPolicy(wrongInspectionOption),
    /gateway_mode_ipv4/u,
  );

  const ipv6Enabled = orchestrate.replace(
    ".EnableIPv6 == false",
    ".EnableIPv6 == true",
  );
  assert.throws(() => assertIsolatedNetworkPolicy(ipv6Enabled), /EnableIPv6/u);
});

test("proves host-gateway, public, private, link-local, and DNS containment", () => {
  for (const required of [
    '[[ "$(uname -s)" == Linux ]]',
    'server.listen(0, "0.0.0.0"',
    'host_marker_pid="$!"',
    'kill "$host_marker_pid"',
    '--env "HOST_MARKER_PORT=$host_marker_port"',
    "/proc/net/route",
    "isolated network exposed",
    "expected exactly one active connected route",
    "bridgeGateway",
    "trusted host-gateway marker",
    '"1.1.1.1"',
    '"10.255.255.1"',
    '"172.16.255.254"',
    '"192.168.255.254"',
    '"169.254.169.254"',
    ".invalid",
    '"example.com"',
    "publicDnsBlocked",
    "socket.setTimeout(1_500",
    "hostGatewayMarkerBlocked: true",
    "defaultRouteAbsent: true",
    "rfc1918EgressBlocked: true",
    "linkLocalEgressBlocked: true",
  ]) {
    assert.ok(
      orchestrate.includes(required) || hostile.includes(required),
      `missing hostile containment proof: ${required}`,
    );
  }
  assert.match(
    orchestrate,
    />"\$private_logs\/hostile-containment\.log" 2>&1/u,
  );
  assert.doesNotMatch(orchestrate, /docker logs|--network host/u);
});

test("verifies the created EP artifact container image before copying", () => {
  const createIndex = orchestrate.indexOf(
    'ep_artifact_container="$(docker create "$ep_image")"',
  );
  const inspectIndex = orchestrate.indexOf(
    "docker inspect --format '{{.Image}}' \"$ep_artifact_container\"",
  );
  const compareIndex = orchestrate.indexOf(
    `"$(jq -r '.ep' "$evidence_root/image-digests.json")"`,
    inspectIndex,
  );
  const copyIndex = orchestrate.indexOf(
    '"$ep_artifact_container:/bundle/lvis-plugin-ep.zip"',
  );

  assert.ok(createIndex >= 0, "EP artifact container creation is missing");
  assert.ok(inspectIndex > createIndex, "EP artifact image inspection must follow creation");
  assert.ok(compareIndex > inspectIndex, "EP artifact image must match the recorded EP IID");
  assert.ok(copyIndex > compareIndex, "EP artifact copy must follow image identity verification");
});
