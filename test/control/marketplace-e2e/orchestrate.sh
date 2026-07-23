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
control_dir="$control_root/test/control/marketplace-e2e"
for path in "$control_root" "$contexts_root" "$evidence_root"; do
  [[ -d "$path" && ! -L "$path" ]] || fail "trusted control directory is invalid"
done
install -d -m 0700 "$artifacts_root" "$export_root" "$private_logs"

suffix="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
marketplace_image="lvis-marketplace-e2e:${suffix}"
ep_image="lvis-ep-e2e:${suffix}"
host_image="lvis-host-e2e:${suffix}"
evidence_image="lvis-evidence-control:${suffix}"
artifacts_image="lvis-artifacts-control:${suffix}"
network="lvis-e2e-${suffix}"
evidence_volume="lvis-evidence-${suffix}"
artifacts_volume="lvis-artifacts-${suffix}"
marketplace_container="lvis-marketplace-${suffix}"
host_container="lvis-host-${suffix}"
ep_artifact_container=""

cleanup() {
  set +e
  docker rm -f "$host_container" "$marketplace_container" \
    >"$private_logs/cleanup-containers.log" 2>&1
  if [[ -n "$ep_artifact_container" ]]; then
    docker rm -f "$ep_artifact_container" \
      >>"$private_logs/cleanup-containers.log" 2>&1
  fi
  docker network rm "$network" >"$private_logs/cleanup-network.log" 2>&1
  docker volume rm "$evidence_volume" "$artifacts_volume" \
    >"$private_logs/cleanup-volumes.log" 2>&1
  docker image rm \
    "$evidence_image" "$artifacts_image" \
    "$host_image" "$ep_image" "$marketplace_image" \
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

build_image \
  marketplace "$control_dir/Dockerfile.marketplace" \
  "$contexts_root/marketplace" "$marketplace_image"
build_image \
  ep "$control_dir/Dockerfile.ep" \
  "$contexts_root/ep" "$ep_image"
build_image \
  host "$control_dir/Dockerfile.host" \
  "$contexts_root/host" "$host_image" \
  --build-arg "CONTROL_SHA=$CONTROL_SHA" \
  --build-arg "HOST_SHA=$HOST_SHA"

jq -n \
  --arg marketplace "$(cat "$evidence_root/marketplace-image.iid")" \
  --arg ep "$(cat "$evidence_root/ep-image.iid")" \
  --arg host "$(cat "$evidence_root/host-image.iid")" \
  '{marketplace:$marketplace,ep:$ep,host:$host}' \
  >"$evidence_root/image-digests.json"
rm -f \
  "$evidence_root/marketplace-image.iid" \
  "$evidence_root/ep-image.iid" \
  "$evidence_root/host-image.iid"

ep_artifact_container="$(docker create "$ep_image")"
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

docker network create --internal "$network" \
  >"$private_logs/network-create.log" 2>&1 \
  || fail "internal Docker network creation failed"

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
marketplace_ip="$(
  docker inspect \
    --format "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" \
    "$marketplace_container"
)"
python3 - "$marketplace_ip" <<'PY' \
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

if ! docker run --rm \
  "${hostile_runtime_flags[@]}" \
  --mount "type=volume,src=$evidence_volume,dst=/evidence" \
  --mount "type=volume,src=$artifacts_volume,dst=/artifacts,readonly" \
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
