#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "::error::Trusted Marketplace E2E control failed: $1" >&2
  exit 1
}

for name in \
  HOST_SHA MARKETPLACE_SHA SDK_SHA EP_API_SHA CONTROL_SHA \
  GITHUB_RUN_ID GITHUB_RUN_ATTEMPT PUBLISHER_KEY ADMIN_KEY
do
  [[ -n "${!name:-}" ]] || fail "$name is required"
done
for sha in "$HOST_SHA" "$MARKETPLACE_SHA" "$SDK_SHA" "$EP_API_SHA" "$CONTROL_SHA"; do
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "all refs must be exact lowercase SHAs"
done
[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]] || fail "GITHUB_RUN_ID is invalid"
[[ "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || fail "GITHUB_RUN_ATTEMPT is invalid"

workspace="$(pwd -P)"
run_root="$workspace/.control"
control_root="$run_root/trusted"
contexts_root="$run_root/contexts"
evidence_root="$run_root/evidence"
artifacts_root="$run_root/artifacts"
export_root="$run_root/export"
private_logs="$run_root/private-logs"
dependency_inputs_root="$run_root/dependency-inputs"
control_dir="$control_root/test/control/marketplace-e2e"
for path in "$control_root" "$contexts_root" "$evidence_root"; do
  [[ -d "$path" && ! -L "$path" ]] || fail "trusted control directory is invalid"
done
install -d -m 0700 \
  "$artifacts_root" "$export_root" "$private_logs" "$dependency_inputs_root"
marketplace_input_sha="$(
  jq -er '.sdkOverlay.imageInputArchiveSha256' \
    "$evidence_root/input-bindings.json"
)"
[[ "$marketplace_input_sha" =~ ^[0-9a-f]{64}$ ]] \
  || fail "Marketplace image input digest is invalid"

suffix="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
marketplace_image="lvis-marketplace-e2e:${suffix}"
ep_image="lvis-ep-e2e:${suffix}"
host_image="lvis-host-e2e:${suffix}"
evidence_image="lvis-evidence-control:${suffix}"
artifacts_image="lvis-artifacts-control:${suffix}"
dependency_proxy_image="lvis-dependency-proxy:${suffix}"
host_dependency_seed_image="lvis-host-dependency-seed:${suffix}"
ep_dependency_seed_image="lvis-ep-dependency-seed:${suffix}"
marketplace_dependency_seed_image="lvis-marketplace-dependency-seed:${suffix}"
host_dependency_image="lvis-host-dependencies:${suffix}"
ep_dependency_image="lvis-ep-dependencies:${suffix}"
marketplace_dependency_image="lvis-marketplace-dependencies:${suffix}"
network="lvis-e2e-${suffix}"
dependency_fetch_network="lvis-dependency-fetch-${suffix}"
dependency_egress_network="lvis-dependency-egress-${suffix}"
evidence_volume="lvis-evidence-${suffix}"
artifacts_volume="lvis-artifacts-${suffix}"
marketplace_container="lvis-marketplace-${suffix}"
host_container="lvis-host-${suffix}"
host_dependency_proxy_container="lvis-host-dependency-proxy-${suffix}"
ep_dependency_proxy_container="lvis-ep-dependency-proxy-${suffix}"
marketplace_dependency_proxy_container="lvis-marketplace-dependency-proxy-${suffix}"
host_dependency_container="lvis-host-dependency-fetch-${suffix}"
ep_dependency_container="lvis-ep-dependency-fetch-${suffix}"
marketplace_dependency_container="lvis-marketplace-dependency-fetch-${suffix}"
host_marker_pid=""
ep_artifact_container=""

cleanup() {
  set +e
  if [[ -n "$host_marker_pid" ]]; then
    kill "$host_marker_pid" >"$private_logs/cleanup-host-marker.log" 2>&1 || true
    wait "$host_marker_pid" >>"$private_logs/cleanup-host-marker.log" 2>&1 || true
  fi
  docker rm -f "$host_container" "$marketplace_container" \
    "$host_dependency_container" "$ep_dependency_container" \
    "$marketplace_dependency_container" \
    "$host_dependency_proxy_container" "$ep_dependency_proxy_container" \
    "$marketplace_dependency_proxy_container" \
    >"$private_logs/cleanup-containers.log" 2>&1
  if [[ -n "$ep_artifact_container" ]]; then
    docker rm -f "$ep_artifact_container" \
      >>"$private_logs/cleanup-containers.log" 2>&1
  fi
  docker network rm "$network" >"$private_logs/cleanup-network.log" 2>&1
  docker network rm "$dependency_fetch_network" "$dependency_egress_network" \
    >>"$private_logs/cleanup-network.log" 2>&1
  docker volume rm "$evidence_volume" "$artifacts_volume" \
    >"$private_logs/cleanup-volumes.log" 2>&1
  docker image rm \
    "$evidence_image" "$artifacts_image" \
    "$host_image" "$ep_image" "$marketplace_image" \
    "$host_dependency_image" "$ep_dependency_image" \
    "$marketplace_dependency_image" \
    "$host_dependency_seed_image" "$ep_dependency_seed_image" \
    "$marketplace_dependency_seed_image" "$dependency_proxy_image" \
    >"$private_logs/cleanup-images.log" 2>&1
}
trap cleanup EXIT

build_image() {
  local name="$1"
  local dockerfile="$2"
  local candidate_context="$3"
  local tag="$4"
  shift 4
  local log="$private_logs/${name}-build.log"
  local iid="$evidence_root/${name}-image.iid"
  if ! docker buildx build \
    --load \
    --quiet \
    --provenance=false \
    --sbom=false \
    --iidfile "$iid" \
    --file "$dockerfile" \
    --build-context "candidate=$candidate_context" \
    --build-context "control=$control_root" \
    --build-context "evidence=$evidence_root" \
    --tag "$tag" \
    "$@" \
    "$control_dir" \
    >"$log" 2>&1
  then
    fail "$name candidate image build failed (private log retained only on runner)"
  fi
  [[ "$(cat "$iid")" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "$name image ID is not a SHA-256 digest"
}

install -d -m 0700 \
  "$dependency_inputs_root/host" \
  "$dependency_inputs_root/ep" \
  "$dependency_inputs_root/marketplace"
install -m 0600 \
  "$contexts_root/host/package.json" \
  "$contexts_root/host/bun.lock" \
  "$dependency_inputs_root/host/"
install -m 0600 \
  "$contexts_root/ep/package.json" \
  "$contexts_root/ep/bun.lock" \
  "$dependency_inputs_root/ep/"
install -m 0600 \
  "$contexts_root/marketplace/server/pyproject.toml" \
  "$contexts_root/marketplace/server/uv.lock" \
  "$dependency_inputs_root/marketplace/"

dependency_input_sha() {
  local root="$1"
  shift
  local file
  for file in "$@"; do
    [[ -f "$root/$file" && ! -L "$root/$file" ]] \
      || fail "dependency input $file is not a sealed regular file"
  done
  (
    cd "$root"
    sha256sum "$@"
  ) | sha256sum | cut -d' ' -f1
}

host_dependency_input_sha="$(
  dependency_input_sha "$dependency_inputs_root/host" package.json bun.lock
)"
ep_dependency_input_sha="$(
  dependency_input_sha "$dependency_inputs_root/ep" package.json bun.lock
)"
marketplace_dependency_input_sha="$(
  dependency_input_sha \
    "$dependency_inputs_root/marketplace" pyproject.toml uv.lock
)"
for sha in \
  "$host_dependency_input_sha" \
  "$ep_dependency_input_sha" \
  "$marketplace_dependency_input_sha"
do
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] \
    || fail "dependency input digest is invalid"
done

build_dependency_control_image() {
  local name="$1"
  local dockerfile="$2"
  local tag="$3"
  shift 3
  if ! docker buildx build \
    --load \
    --quiet \
    --network none \
    --provenance=false \
    --sbom=false \
    --file "$dockerfile" \
    --build-context "control=$control_root" \
    "$@" \
    --tag "$tag" \
    "$control_dir" \
    >"$private_logs/${name}-build.log" 2>&1
  then
    fail "$name trusted dependency control image build failed"
  fi
}

build_dependency_control_image \
  dependency-proxy "$control_dir/Dockerfile.dependency-proxy" \
  "$dependency_proxy_image"
build_dependency_control_image \
  host-dependency-seed "$control_dir/Dockerfile.dependency-bun" \
  "$host_dependency_seed_image" \
  --build-context "input=$dependency_inputs_root/host" \
  --build-arg MODE=host
build_dependency_control_image \
  ep-dependency-seed "$control_dir/Dockerfile.dependency-bun" \
  "$ep_dependency_seed_image" \
  --build-context "input=$dependency_inputs_root/ep" \
  --build-arg MODE=ep \
  --build-arg "SDK_SHA=$SDK_SHA"
build_dependency_control_image \
  marketplace-dependency-seed "$control_dir/Dockerfile.dependency-uv" \
  "$marketplace_dependency_seed_image" \
  --build-context "input=$dependency_inputs_root/marketplace"

dependency_third_octet="$(( (GITHUB_RUN_ID + GITHUB_RUN_ATTEMPT + 73) % 200 + 20 ))"
dependency_subnet="172.28.${dependency_third_octet}.0/24"
dependency_gateway="172.28.${dependency_third_octet}.1"
host_dependency_proxy_ip="172.28.${dependency_third_octet}.10"
ep_dependency_proxy_ip="172.28.${dependency_third_octet}.11"
marketplace_dependency_proxy_ip="172.28.${dependency_third_octet}.12"
host_dependency_ip="172.28.${dependency_third_octet}.20"
ep_dependency_ip="172.28.${dependency_third_octet}.21"
marketplace_dependency_ip="172.28.${dependency_third_octet}.22"

docker network create \
  --driver bridge \
  --ipv6=false \
  "$dependency_egress_network" \
  >"$private_logs/dependency-egress-network-create.log" 2>&1 \
  || fail "dependency proxy egress network creation failed"
docker network create --internal \
  --driver bridge \
  --ipv6=false \
  --subnet "$dependency_subnet" \
  --gateway "$dependency_gateway" \
  -o com.docker.network.bridge.gateway_mode_ipv4=isolated \
  "$dependency_fetch_network" \
  >"$private_logs/dependency-fetch-network-create.log" 2>&1 \
  || fail "isolated dependency fetch network creation failed"

create_dependency_proxy() {
  local name="$1"
  local ip="$2"
  local allowed_client_ip="$3"
  local allowed_hosts="$4"
  docker create \
    --name "$name" \
    --network "$dependency_fetch_network" \
    --ip "$ip" \
    --user 10004:10004 \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 128 \
    --memory 256m \
    --cpus 1 \
    --env "ALLOWED_HOSTS=$allowed_hosts" \
    --env "ALLOWED_CLIENT_IP=$allowed_client_ip" \
    --env "PROXY_BIND_ADDRESS=$ip" \
    --env PROXY_PORT=8443 \
    "$dependency_proxy_image" \
    >"$private_logs/${name}-create.log" 2>&1 \
    || fail "$name creation failed"
  docker network connect --gw-priority 1 "$dependency_egress_network" "$name" \
    >"$private_logs/${name}-network-connect.log" 2>&1 \
    || fail "$name internal network attachment failed"
  docker start "$name" >"$private_logs/${name}-start.log" 2>&1 \
    || fail "$name failed to start"
  [[ "$(
    docker inspect --format '{{len .NetworkSettings.Networks}}' "$name"
  )" == 2 ]] || fail "$name must be the only dual-homed dependency component"
  [[ "$(
    docker inspect \
      --format "{{(index .NetworkSettings.Networks \"$dependency_fetch_network\").IPAddress}}" \
      "$name"
  )" == "$ip" ]] || fail "$name internal proxy IP does not match policy"
  [[ "$(
    docker inspect \
      --format "{{if index .NetworkSettings.Networks \"$dependency_fetch_network\"}}fetch{{end}}:{{if index .NetworkSettings.Networks \"$dependency_egress_network\"}}egress{{end}}" \
      "$name"
  )" == "fetch:egress" ]] || fail "$name network names do not match policy"
}

create_dependency_proxy \
  "$host_dependency_proxy_container" \
  "$host_dependency_proxy_ip" \
  "$host_dependency_ip" \
  registry.npmjs.org
create_dependency_proxy \
  "$ep_dependency_proxy_container" \
  "$ep_dependency_proxy_ip" \
  "$ep_dependency_ip" \
  registry.npmjs.org,github.com,api.github.com,codeload.github.com
create_dependency_proxy \
  "$marketplace_dependency_proxy_container" \
  "$marketplace_dependency_proxy_ip" \
  "$marketplace_dependency_ip" \
  pypi.org,files.pythonhosted.org

prove_dependency_proxy_ready() {
  local name="$1"
  local proxy_ip="$2"
  local probe_ip="$3"
  local ready=false
  for _ in $(seq 1 30); do
    if docker run --rm \
      --network "$dependency_fetch_network" \
      --ip "$probe_ip" \
      --dns 127.0.0.1 \
      --cap-drop ALL \
      --security-opt no-new-privileges \
      --pids-limit 32 \
      --memory 128m \
      --cpus 0.5 \
      --entrypoint bun \
      "$dependency_proxy_image" \
      -e "
        const socket = await Bun.connect({
          hostname: \"${proxy_ip}\",
          port: 8443,
          socket: {
            data(_socket, data) {
              const response = new TextDecoder().decode(data);
              process.exit(response.startsWith(\"HTTP/1.1 403 \") ? 0 : 1);
            },
            error() { process.exit(1); },
          },
        });
        socket.write(\"CONNECT registry.npmjs.org:443 HTTP/1.1\\\\r\\\\n\\\\r\\\\n\");
        setTimeout(() => process.exit(1), 1000);
      " \
      >"$private_logs/${name}-readiness.log" 2>&1
    then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || fail "$name did not become ready"
}

prove_dependency_proxy_ready host "$host_dependency_proxy_ip" \
  "172.28.${dependency_third_octet}.30"
prove_dependency_proxy_ready ep "$ep_dependency_proxy_ip" \
  "172.28.${dependency_third_octet}.31"
prove_dependency_proxy_ready marketplace "$marketplace_dependency_proxy_ip" \
  "172.28.${dependency_third_octet}.32"

if ! docker run --rm \
  --network "$dependency_fetch_network" \
  --ip "172.28.${dependency_third_octet}.33" \
  --dns 127.0.0.1 \
  --dns-option timeout:1 \
  --dns-option attempts:1 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 32 \
  --memory 128m \
  --cpus 0.5 \
  --entrypoint bun \
  "$dependency_proxy_image" \
  -e '
    import net from "node:net";
    import { lookup } from "node:dns/promises";
    const directBlocked = await new Promise((resolve) => {
      const socket = net.connect({ host: "1.1.1.1", port: 443 });
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(true));
    });
    let dnsBlocked = false;
    try {
      await lookup("example.com");
    } catch {
      dnsBlocked = true;
    }
    process.exit(directBlocked && dnsBlocked ? 0 : 1);
  ' \
  >"$private_logs/dependency-direct-egress-proof.log" 2>&1
then
  fail "dependency fetch network permitted direct public IP or DNS egress"
fi

fetch_dependency_image() {
  local name="$1"
  local seed_image="$2"
  local container="$3"
  local ip="$4"
  local proxy_ip="$5"
  local output_image="$6"
  local log="$private_logs/${name}-fetch.log"
  local downloader_user
  set +e
  docker run \
    --name "$container" \
    --network "$dependency_fetch_network" \
    --ip "$ip" \
    --dns 127.0.0.1 \
    --dns-option timeout:1 \
    --dns-option attempts:1 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 256 \
    --memory 4g \
    --cpus 2 \
    --env "HTTPS_PROXY=http://${proxy_ip}:8443" \
    --env "https_proxy=http://${proxy_ip}:8443" \
    --env "HTTP_PROXY=http://${proxy_ip}:8443" \
    --env "http_proxy=http://${proxy_ip}:8443" \
    --env "ALL_PROXY=http://${proxy_ip}:8443" \
    --env "all_proxy=http://${proxy_ip}:8443" \
    --env NO_PROXY= \
    --env no_proxy= \
    "$seed_image" \
    >"$log" 2>&1
  local exit_code="$?"
  set -e
  [[ "$exit_code" == 0 ]] \
    || fail "$name dependency downloader failed (private log retained only on runner)"
  [[ "$(
    docker inspect --format '{{len .NetworkSettings.Networks}}' "$container"
  )" == 1 ]] || fail "$name downloader must attach only to the internal network"
  downloader_user="$(docker inspect --format '{{.Config.User}}' "$container")"
  [[ -n "$downloader_user" \
    && "$downloader_user" != 0 \
    && "$downloader_user" != root \
    && "$downloader_user" != 0:0 ]] \
    || fail "$name downloader must run as a non-root user"
  [[ "$(
    docker inspect --format '{{json .Mounts}}' "$container"
  )" == "[]" ]] || fail "$name downloader must not receive mounts"
  [[ "$(
    docker inspect --format '{{.HostConfig.CapDrop}}' "$container"
  )" == "[ALL]" ]] || fail "$name downloader capabilities are not dropped"
  [[ "$(
    docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$container"
  )" == '["no-new-privileges"]' ]] \
    || fail "$name downloader no-new-privileges policy is absent"
  [[ "$(
    docker inspect \
      --format "{{(index .NetworkSettings.Networks \"$dependency_fetch_network\").IPAddress}}" \
      "$container"
  )" == "$ip" ]] || fail "$name downloader did not receive its fixed internal IP"
  docker commit \
    --change 'ENV HTTPS_PROXY=' \
    --change 'ENV https_proxy=' \
    --change 'ENV HTTP_PROXY=' \
    --change 'ENV http_proxy=' \
    --change 'ENV ALL_PROXY=' \
    --change 'ENV all_proxy=' \
    "$container" "$output_image" \
    >"$private_logs/${name}-commit.log" 2>&1 \
    || fail "$name dependency image commit failed"
  docker rm "$container" >"$private_logs/${name}-remove.log" 2>&1 \
    || fail "$name downloader cleanup failed"
}

fetch_dependency_image \
  host "$host_dependency_seed_image" "$host_dependency_container" \
  "$host_dependency_ip" "$host_dependency_proxy_ip" "$host_dependency_image"
fetch_dependency_image \
  ep "$ep_dependency_seed_image" "$ep_dependency_container" \
  "$ep_dependency_ip" "$ep_dependency_proxy_ip" "$ep_dependency_image"
fetch_dependency_image \
  marketplace "$marketplace_dependency_seed_image" \
  "$marketplace_dependency_container" "$marketplace_dependency_ip" \
  "$marketplace_dependency_proxy_ip" "$marketplace_dependency_image"

host_dependency_image_id="$(docker image inspect --format '{{.Id}}' "$host_dependency_image")"
ep_dependency_image_id="$(docker image inspect --format '{{.Id}}' "$ep_dependency_image")"
marketplace_dependency_image_id="$(
  docker image inspect --format '{{.Id}}' "$marketplace_dependency_image"
)"
for image_id in \
  "$host_dependency_image_id" \
  "$ep_dependency_image_id" \
  "$marketplace_dependency_image_id"
do
  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || fail "committed dependency image ID is invalid"
done

docker network inspect "$dependency_fetch_network" \
  >"$private_logs/dependency-fetch-network-inspect.json" 2>&1 \
  || fail "dependency fetch network inspection failed"
jq -e \
  --arg subnet "$dependency_subnet" \
  --arg gateway "$dependency_gateway" \
  --arg hostProxy "$host_dependency_proxy_container" \
  --arg epProxy "$ep_dependency_proxy_container" \
  --arg marketplaceProxy "$marketplace_dependency_proxy_container" \
  '
    length == 1
    and .[0].Internal == true
    and .[0].EnableIPv6 == false
    and .[0].IPAM.Config == [{"Subnet": $subnet, "Gateway": $gateway}]
    and .[0].Options == {
      "com.docker.network.bridge.gateway_mode_ipv4": "isolated"
    }
    and ((.[0].Containers | to_entries | map(.value.Name) | sort)
      == ([$hostProxy, $epProxy, $marketplaceProxy] | sort))
  ' "$private_logs/dependency-fetch-network-inspect.json" \
  >"$private_logs/dependency-fetch-network-policy-check.log" 2>&1 \
  || fail "dependency fetch topology does not match the isolated proxy policy"
docker network inspect "$dependency_egress_network" \
  >"$private_logs/dependency-egress-network-inspect.json" 2>&1 \
  || fail "dependency egress network inspection failed"
jq -e \
  --arg hostProxy "$host_dependency_proxy_container" \
  --arg epProxy "$ep_dependency_proxy_container" \
  --arg marketplaceProxy "$marketplace_dependency_proxy_container" \
  '
    length == 1
    and .[0].Internal == false
    and .[0].EnableIPv6 == false
    and ((.[0].Containers | to_entries | map(.value.Name) | sort)
      == ([$hostProxy, $epProxy, $marketplaceProxy] | sort))
  ' "$private_logs/dependency-egress-network-inspect.json" \
  >"$private_logs/dependency-egress-network-policy-check.log" 2>&1 \
  || fail "dependency egress network must contain exactly the trusted proxies"

docker rm -f \
  "$host_dependency_proxy_container" \
  "$ep_dependency_proxy_container" \
  "$marketplace_dependency_proxy_container" \
  >"$private_logs/dependency-proxies-remove.log" 2>&1 \
  || fail "dependency proxy cleanup failed"
docker network rm "$dependency_fetch_network" "$dependency_egress_network" \
  >"$private_logs/dependency-networks-remove.log" 2>&1 \
  || fail "dependency network cleanup failed"

build_image \
  marketplace "$control_dir/Dockerfile.marketplace" \
  "$contexts_root/marketplace" "$marketplace_image" \
  --build-context "dependencies=docker-image://$marketplace_dependency_image" \
  --build-arg "CANDIDATE_INPUT_SHA256=$marketplace_input_sha" \
  --build-arg "DEPENDENCY_IMAGE_ID=$marketplace_dependency_image_id" \
  --build-arg "DEPENDENCY_INPUT_SHA256=$marketplace_dependency_input_sha"
build_image \
  ep "$control_dir/Dockerfile.ep" \
  "$contexts_root/ep" "$ep_image" \
  --build-context "dependencies=docker-image://$ep_dependency_image" \
  --build-arg "SDK_SHA=$SDK_SHA" \
  --build-arg "DEPENDENCY_IMAGE_ID=$ep_dependency_image_id" \
  --build-arg "DEPENDENCY_INPUT_SHA256=$ep_dependency_input_sha"
build_image \
  host "$control_dir/Dockerfile.host" \
  "$contexts_root/host" "$host_image" \
  --build-context "dependencies=docker-image://$host_dependency_image" \
  --build-arg "CONTROL_SHA=$CONTROL_SHA" \
  --build-arg "HOST_SHA=$HOST_SHA" \
  --build-arg "DEPENDENCY_IMAGE_ID=$host_dependency_image_id" \
  --build-arg "DEPENDENCY_INPUT_SHA256=$host_dependency_input_sha"

[[ "$(docker image inspect --format '{{.Id}}' "$host_dependency_image")" \
  == "$host_dependency_image_id" ]] \
  || fail "Host dependency image tag changed during candidate build"
[[ "$(docker image inspect --format '{{.Id}}' "$ep_dependency_image")" \
  == "$ep_dependency_image_id" ]] \
  || fail "EP dependency image tag changed during candidate build"
[[ "$(docker image inspect --format '{{.Id}}' "$marketplace_dependency_image")" \
  == "$marketplace_dependency_image_id" ]] \
  || fail "Marketplace dependency image tag changed during candidate build"

observed_marketplace_input_sha="$(
  docker image inspect \
    --format '{{ index .Config.Labels "ai.lvis.candidate-input-sha256" }}' \
    "$marketplace_image"
)"
[[ "$observed_marketplace_input_sha" == "$marketplace_input_sha" ]] \
  || fail "Marketplace image input digest label does not match the sealed context"

verify_dependency_labels() {
  local image="$1"
  local expected_image_id="$2"
  local expected_input_sha="$3"
  local observed_image_id
  local observed_input_sha
  observed_image_id="$(
    docker image inspect \
      --format '{{ index .Config.Labels "ai.lvis.dependency-image-id" }}' \
      "$image"
  )"
  observed_input_sha="$(
    docker image inspect \
      --format '{{ index .Config.Labels "ai.lvis.dependency-input-sha256" }}' \
      "$image"
  )"
  [[ "$observed_image_id" == "$expected_image_id" ]] \
    || fail "candidate image dependency ID label does not match"
  [[ "$observed_input_sha" == "$expected_input_sha" ]] \
    || fail "candidate image dependency input label does not match"
}

verify_dependency_labels \
  "$host_image" "$host_dependency_image_id" "$host_dependency_input_sha"
verify_dependency_labels \
  "$ep_image" "$ep_dependency_image_id" "$ep_dependency_input_sha"
verify_dependency_labels \
  "$marketplace_image" \
  "$marketplace_dependency_image_id" "$marketplace_dependency_input_sha"
[[ "$(
  docker image inspect \
    --format '{{ index .Config.Labels "org.lvis.sdk-sha" }}' \
    "$ep_image"
)" == "$SDK_SHA" ]] || fail "EP image SDK SHA label does not match"

jq -n \
  --arg marketplace "$(cat "$evidence_root/marketplace-image.iid")" \
  --arg ep "$(cat "$evidence_root/ep-image.iid")" \
  --arg host "$(cat "$evidence_root/host-image.iid")" \
  --arg marketplaceDependency "$marketplace_dependency_image_id" \
  --arg epDependency "$ep_dependency_image_id" \
  --arg hostDependency "$host_dependency_image_id" \
  --arg marketplaceDependencyInput "$marketplace_dependency_input_sha" \
  --arg epDependencyInput "$ep_dependency_input_sha" \
  --arg hostDependencyInput "$host_dependency_input_sha" \
  '{
    marketplace:$marketplace,
    ep:$ep,
    host:$host,
    marketplaceDependency:$marketplaceDependency,
    epDependency:$epDependency,
    hostDependency:$hostDependency,
    marketplaceDependencyInput:$marketplaceDependencyInput,
    epDependencyInput:$epDependencyInput,
    hostDependencyInput:$hostDependencyInput
  }' \
  >"$evidence_root/image-digests.json"
rm -f \
  "$evidence_root/marketplace-image.iid" \
  "$evidence_root/ep-image.iid" \
  "$evidence_root/host-image.iid"

ep_artifact_container="$(docker create "$ep_image")"
if ! observed_ep_artifact_image="$(
  docker inspect --format '{{.Image}}' "$ep_artifact_container" \
    2>"$private_logs/ep-artifact-inspect.log"
)"; then
  fail "EP artifact container image inspection failed"
fi
[[ "$observed_ep_artifact_image" == "$(jq -r '.ep' "$evidence_root/image-digests.json")" ]] \
  || fail "EP artifact container image does not match the recorded build digest"
docker cp \
  "$ep_artifact_container:/bundle/lvis-plugin-ep.zip" \
  "$artifacts_root/lvis-plugin-ep.zip" \
  >"$private_logs/ep-artifact-copy.log" 2>&1 \
  || fail "EP artifact export failed"
docker rm "$ep_artifact_container" >"$private_logs/ep-artifact-remove.log" 2>&1
ep_artifact_container=""
[[ -f "$artifacts_root/lvis-plugin-ep.zip" \
  && ! -L "$artifacts_root/lvis-plugin-ep.zip" ]] \
  || fail "EP artifact is not a regular file"
unzip -tqq "$artifacts_root/lvis-plugin-ep.zip" \
  >"$private_logs/ep-artifact-verify.log" 2>&1 \
  || fail "EP artifact is not a valid ZIP"
chmod -R a-w "$artifacts_root"

build_trusted_control_image() {
  local name="$1"
  local dockerfile="$2"
  local tag="$3"
  shift 3
  if ! docker buildx build \
    --load \
    --quiet \
    --provenance=false \
    --sbom=false \
    --file "$dockerfile" \
    --build-context "control=$control_root" \
    "$@" \
    --tag "$tag" \
    "$control_dir" \
    >"$private_logs/${name}-build.log" 2>&1
  then
    fail "$name trusted control image build failed"
  fi
}

build_trusted_control_image \
  artifacts-control "$control_dir/Dockerfile.artifacts" "$artifacts_image" \
  --build-context "artifacts=$artifacts_root"
build_trusted_control_image \
  evidence-control "$control_dir/Dockerfile.evidence" "$evidence_image" \
  --build-context "evidence=$evidence_root"

docker volume create "$artifacts_volume" \
  >"$private_logs/artifacts-volume-create.log" 2>&1 \
  || fail "artifact volume creation failed"
docker volume create "$evidence_volume" \
  >"$private_logs/evidence-volume-create.log" 2>&1 \
  || fail "evidence volume creation failed"
docker run --rm \
  --network none \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=volume,src=$artifacts_volume,dst=/artifacts" \
  "$artifacts_image" \
  >"$private_logs/artifacts-volume-seed.log" 2>&1 \
  || fail "artifact volume initialization failed"
docker run --rm \
  --network none \
  --user 10003:10003 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  "$evidence_image" \
  -e 'process.exit(0)' \
  >"$private_logs/evidence-volume-seed.log" 2>&1 \
  || fail "evidence volume initialization failed"

network_third_octet="$(( (GITHUB_RUN_ID + GITHUB_RUN_ATTEMPT) % 200 + 20 ))"
network_subnet="172.30.${network_third_octet}.0/24"
network_gateway="172.30.${network_third_octet}.1"
marketplace_ip="172.30.${network_third_octet}.10"
docker network create --internal \
  --driver bridge \
  --ipv6=false \
  --subnet "$network_subnet" \
  --gateway "$network_gateway" \
  -o com.docker.network.bridge.gateway_mode_ipv4=isolated \
  "$network" \
  >"$private_logs/network-create.log" 2>&1 \
  || fail "isolated internal Docker network creation failed"
docker network inspect "$network" >"$private_logs/network-inspect.json" 2>&1 \
  || fail "isolated Docker network inspection failed"
jq -e \
  --arg name "$network" \
  --arg subnet "$network_subnet" \
  --arg gateway "$network_gateway" \
  '
    length == 1
    and .[0].Name == $name
    and .[0].Driver == "bridge"
    and .[0].Scope == "local"
    and .[0].Internal == true
    and .[0].EnableIPv6 == false
    and .[0].Attachable == false
    and .[0].Ingress == false
    and .[0].ConfigOnly == false
    and .[0].ConfigFrom == {"Network": ""}
    and .[0].IPAM == {
      "Driver": "default",
      "Options": {},
      "Config": [{"Subnet": $subnet, "Gateway": $gateway}]
    }
    and .[0].Options == {
      "com.docker.network.bridge.gateway_mode_ipv4": "isolated"
    }
    and .[0].Labels == {}
    and .[0].Containers == {}
  ' "$private_logs/network-inspect.json" \
  >"$private_logs/network-policy-check.log" 2>&1 \
  || fail "Docker network does not match the fail-closed isolation policy"

common_runtime_flags=(
  --network "$network"
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 512
  --memory 6g
  --cpus 4
  --shm-size 1g
)
host_runtime_flags=(
  "${common_runtime_flags[@]}"
  --user 10001:10001
  --tmpfs "/tmp:rw,noexec,nosuid,size=2g,uid=10001,gid=10001,mode=1770"
)
hostile_runtime_flags=(
  "${common_runtime_flags[@]}"
  --user 10002:10002
  --tmpfs "/tmp:rw,noexec,nosuid,size=2g,uid=10002,gid=10002,mode=1770"
)

docker run -d \
  --name "$marketplace_container" \
  --network "$network" \
  --ip "$marketplace_ip" \
  --network-alias marketplace \
  --dns 127.0.0.1 \
  --dns-option timeout:1 \
  --dns-option attempts:1 \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 2g \
  --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,size=512m,uid=10001,gid=10001,mode=1770 \
  --env "PUBLISHER_KEY=$PUBLISHER_KEY" \
  --env "ADMIN_KEY=$ADMIN_KEY" \
  "$marketplace_image" \
  >"$private_logs/marketplace-container-id.log" 2>&1 \
  || fail "Marketplace runtime failed to start"

marketplace_network_count="$(
  docker inspect --format '{{len .NetworkSettings.Networks}}' "$marketplace_container"
)"
[[ "$marketplace_network_count" == 1 ]] \
  || fail "Marketplace runtime must attach to exactly one internal network"
observed_marketplace_ip="$(
  docker inspect \
    --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" \
    "$marketplace_container"
)"
[[ "$observed_marketplace_ip" == "$marketplace_ip" ]] \
  || fail "Marketplace runtime did not receive its fixed isolated IPv4 address"
python3 - "$observed_marketplace_ip" <<'PY' \
  || fail "Marketplace runtime IP is not a private non-loopback IPv4 address"
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if (
    address.version != 4
    or not address.is_private
    or address.is_loopback
    or address.is_link_local
    or address.is_unspecified
    or address.is_multicast
):
    raise SystemExit(1)
PY
dns_isolation_flags=(
  --dns 127.0.0.1
  --dns-option timeout:1
  --dns-option attempts:1
  --add-host "marketplace:$marketplace_ip"
)
host_runtime_flags+=("${dns_isolation_flags[@]}")
hostile_runtime_flags+=("${dns_isolation_flags[@]}")

marketplace_ready=false
for _ in $(seq 1 60); do
  if docker run --rm \
    "${host_runtime_flags[@]}" \
    --entrypoint node \
    "$host_image" \
    -e 'fetch("http://marketplace:8765/api/v1/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' \
    >"$private_logs/marketplace-health.log" 2>&1
  then
    marketplace_ready=true
    break
  fi
  sleep 1
done
[[ "$marketplace_ready" == true ]] || fail "Marketplace runtime did not become healthy"

[[ "$(uname -s)" == Linux ]] \
  || fail "host-gateway containment proof requires a Linux Docker runner"
node - "$private_logs/host-marker.port" \
  >"$private_logs/host-marker.log" 2>&1 <<'NODE' &
const { writeFileSync } = require("node:fs");
const net = require("node:net");

const portFile = process.argv[2];
const server = net.createServer((socket) => {
  socket.end("LVIS_TRUSTED_HOST_MARKER");
});
server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  if (!address || typeof address === "string") process.exit(1);
  writeFileSync(portFile, `${address.port}\n`, { flag: "wx", mode: 0o600 });
});
NODE
host_marker_pid="$!"
host_marker_port=""
for _ in $(seq 1 30); do
  if [[ -s "$private_logs/host-marker.port" ]]; then
    host_marker_port="$(tr -d '\r\n' <"$private_logs/host-marker.port")"
    break
  fi
  sleep 1
done
[[ "$host_marker_port" =~ ^[0-9]+$ \
  && "$host_marker_port" -ge 1024 \
  && "$host_marker_port" -le 65535 ]] \
  || fail "trusted host-network marker did not publish a valid private port"
kill -0 "$host_marker_pid" >"$private_logs/host-marker-liveness.log" 2>&1 \
  || fail "trusted host-network marker stopped before containment rehearsal"

if ! docker run --rm \
  "${hostile_runtime_flags[@]}" \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  --mount "type=volume,src=$artifacts_volume,dst=/artifacts,readonly" \
  --env "HOST_MARKER_PORT=$host_marker_port" \
  --entrypoint node \
  "$host_image" \
  /trusted/control/run-hostile.mjs \
  >"$private_logs/hostile-containment.log" 2>&1
then
  fail "hostile containment rehearsal failed"
fi

set +e
docker run \
  --name "$host_container" \
  "${host_runtime_flags[@]}" \
  --mount "type=volume,src=$artifacts_volume,dst=/artifacts,readonly" \
  --env M4_E2E=1 \
  --env MARKETPLACE_URL=http://127.0.0.1:8765 \
  --env "MARKETPLACE_PUBLISHER_KEY=$PUBLISHER_KEY" \
  --env "MARKETPLACE_ADMIN_KEY=$ADMIN_KEY" \
  --env MARKETPLACE_UPSTREAM_HOST=marketplace \
  --env MARKETPLACE_UPSTREAM_PORT=8765 \
  --env CANDIDATE_APP_ROOT=/candidate/app \
  --env PLAYWRIGHT_OUTPUT_DIR=/tmp/test-results \
  --env BUNDLE_E2E_EVIDENCE_PATH=/tmp/private-evidence.json \
  --env "HOST_SHA=$HOST_SHA" \
  --env "MARKETPLACE_SHA=$MARKETPLACE_SHA" \
  --env "SDK_SHA=$SDK_SHA" \
  --env "EP_API_SHA=$EP_API_SHA" \
  --env "CONTROL_SHA=$CONTROL_SHA" \
  --env HOME=/tmp/home \
  --env XDG_RUNTIME_DIR=/tmp/xdg \
  "$host_image" \
  >"$private_logs/host-runtime.log" 2>&1
host_exit=$?
set -e
[[ "$host_exit" == 0 ]] || fail "trusted Host E2E control failed with exit $host_exit"
observed_host_exit="$(
  docker inspect --format '{{.State.ExitCode}}' "$host_container"
)"
observed_host_image="$(
  docker inspect --format '{{.Image}}' "$host_container"
)"
[[ "$observed_host_exit" == 0 ]] || fail "Host container exit code was not zero"
[[ "$observed_host_image" == "$(jq -r '.host' "$evidence_root/image-digests.json")" ]] \
  || fail "Host container image does not match the built digest"
observed_marketplace_image="$(
  docker inspect --format '{{.Image}}' "$marketplace_container"
)"
[[ "$observed_marketplace_image" \
  == "$(jq -r '.marketplace' "$evidence_root/image-digests.json")" ]] \
  || fail "running Marketplace image does not match the built digest"

docker run --rm \
  --network none \
  --user 10003:10003 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  --env HOST_EXIT=0 \
  --env "HOST_IMAGE=$observed_host_image" \
  --env "MARKETPLACE_IMAGE=$observed_marketplace_image" \
  --env "HOST_SHA=$HOST_SHA" \
  --env "MARKETPLACE_SHA=$MARKETPLACE_SHA" \
  --env "SDK_SHA=$SDK_SHA" \
  --env "EP_API_SHA=$EP_API_SHA" \
  --env "CONTROL_SHA=$CONTROL_SHA" \
  --entrypoint node \
  "$evidence_image" \
  /trusted/control/write-host-attestation.mjs \
  >"$private_logs/host-attestation-write.log" 2>&1 \
  || fail "trusted Host attestation write failed"

docker stop --time 20 "$marketplace_container" \
  >"$private_logs/marketplace-stop.log" 2>&1 \
  || fail "Marketplace container did not stop cleanly"
marketplace_exit="$(
  docker inspect --format '{{.State.ExitCode}}' "$marketplace_container"
)"
marketplace_runtime_image="$(
  docker inspect --format '{{.Image}}' "$marketplace_container"
)"
[[ "$marketplace_exit" == 0 ]] || fail "Marketplace container exit code was not zero"
[[ "$marketplace_runtime_image" == "$(jq -r '.marketplace' "$evidence_root/image-digests.json")" ]] \
  || fail "Marketplace container image does not match the built digest"

docker run --rm \
  --network none \
  --user 10003:10003 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  --env "HOST_EXIT=$observed_host_exit" \
  --env "MARKETPLACE_EXIT=$marketplace_exit" \
  --env HOSTILE_EXIT=0 \
  --env "HOST_IMAGE=$observed_host_image" \
  --env "MARKETPLACE_IMAGE=$marketplace_runtime_image" \
  --entrypoint node \
  "$evidence_image" \
  /trusted/control/write-container-exits.mjs \
  >"$private_logs/container-exits-write.log" 2>&1 \
  || fail "trusted container-exit evidence write failed"

runner_uid="$(id -u)"
runner_gid="$(id -g)"
docker run --rm \
  --network none \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add FOWNER \
  --security-opt no-new-privileges \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  --env "EXPORT_UID=$runner_uid" \
  --env "EXPORT_GID=$runner_gid" \
  --entrypoint node \
  "$evidence_image" \
  /trusted/control/normalize-evidence.mjs \
  >"$private_logs/evidence-normalize.log" 2>&1 \
  || fail "pre-validation evidence normalization failed"
docker run --rm \
  --network none \
  --user "$runner_uid:$runner_gid" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  --mount "type=bind,src=$export_root,dst=/export" \
  --env "GITHUB_RUN_ID=$GITHUB_RUN_ID" \
  --env "GITHUB_RUN_ATTEMPT=$GITHUB_RUN_ATTEMPT" \
  --env "GITHUB_WORKFLOW_REF=${GITHUB_WORKFLOW_REF:-}" \
  --env "CONTROL_SHA=$CONTROL_SHA" \
  --entrypoint node \
  "$evidence_image" \
  /trusted/control/validate-evidence.mjs /evidence /export \
  >"$private_logs/evidence-validate.log" 2>&1 \
  || fail "trusted evidence validation and export failed"

echo "trusted Marketplace E2E containers completed with verified zero exit codes"
