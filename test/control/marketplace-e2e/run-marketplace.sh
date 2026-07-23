#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo "Marketplace runtime must not run as root" >&2
  exit 1
fi
if [[ -e /var/run/docker.sock ]]; then
  echo "Docker socket must not be visible" >&2
  exit 1
fi

cd /candidate/marketplace/server
export MARKETPLACE_DB_URL="sqlite+aiosqlite:////tmp/marketplace.db"
export LVIS_MARKETPLACE_RATE_LIMIT_DISABLED="1"
export LVIS_MARKETPLACE_SKIP_BOOTSTRAP="1"
export LVIS_MARKETPLACE_PLUGIN_SCHEMA_REMOTE_ENABLED="false"

uv run --offline --no-sync python scripts/seed_e2e_keys.py \
  --publisher-key "$PUBLISHER_KEY" \
  --admin-key "$ADMIN_KEY"

signer_json="$(
  uv run --offline --no-sync python scripts/print_test_poc_signer_env.py --format json
)"
if [[ "$signer_json" == *$'\n'* || ${#signer_json} -gt 8192 ]]; then
  echo "candidate signer output is not a bounded single line" >&2
  exit 1
fi
signer="$(
  SIGNER_JSON="$signer_json" python -c '
import json, os, re
value = json.loads(os.environ["SIGNER_JSON"]).get(
    "MARKETPLACE_SIGNING_PRIVATE_KEY_POC_V1"
)
if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9+/=]{40,4096}", value):
    raise SystemExit("invalid poc signer")
print(value, end="")
'
)"
export MARKETPLACE_SIGNING_PRIVATE_KEY_POC_V1="$signer"
unset signer signer_json SIGNER_JSON

exec uv run --offline --no-sync uvicorn lvis_marketplace.main:create_app \
  --factory --host 0.0.0.0 --port 8765 \
  >/tmp/private-marketplace.log 2>&1
