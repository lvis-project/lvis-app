#!/usr/bin/env bash
# test-cluster-detector.sh — dry-run test harness for the jq filter logic
# used in .github/workflows/cluster-detector.yml.
#
# Exercises the same jq expression against fixture data so CI logic can be
# validated locally without a live GitHub token. Run from any directory:
#
#   bash scripts/test-cluster-detector.sh
#
# Exit code: 0 = all cases passed, 1 = one or more failures.

set -euo pipefail

PASS=0
FAIL=0

# ── jq filter (mirrors cluster-detector.yml §3) ──────────────────────────────
# Accepts: --arg since <ISO8601> --argjson dirs <["dir1","dir2",...]>
# Uses startswith($dirs[]+ "/") to match directory entries without
# over-matching prefixes (e.g. src/preload must not match src/preloader/).
JQ_FILTER='
  [ .[]
    | select(.mergedAt >= $since)
    | select(
        .files
        | map(.path)
        | any(startswith($dirs[] + "/"))
      )
  ] | length
'

SENSITIVE_DIRS=(
  "src/permissions"
  "src/audit"
  "src/sandbox"
  "src/ipc"
  "src/preload"
  "src/boot"
  "src/core/permissions"
)

DIRS_JSON=$(printf '%s\n' "${SENSITIVE_DIRS[@]}" | jq -R . | jq -s .)
SINCE="2026-05-01T00:00:00Z"

run_case() {
  local desc="$1"
  local fixture="$2"
  local expected="$3"

  local got
  got=$(echo "$fixture" | jq --arg since "$SINCE" --argjson dirs "$DIRS_JSON" "$JQ_FILTER")

  if [ "$got" = "$expected" ]; then
    echo "  PASS  $desc (got $got)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $desc (expected $expected, got $got)"
    FAIL=$((FAIL + 1))
  fi
}

echo "── Fixture: 3 PRs touching sensitive areas (should trigger WINDOW_HIT) ──"
run_case "3 sensitive PRs >= CLUSTER_THRESHOLD" \
'[
  {"number":1,"mergedAt":"2026-05-10T10:00:00Z","files":[{"path":"src/permissions/manager.ts"}]},
  {"number":2,"mergedAt":"2026-05-11T10:00:00Z","files":[{"path":"src/audit/logger.ts"}]},
  {"number":3,"mergedAt":"2026-05-12T10:00:00Z","files":[{"path":"src/ipc/handlers.ts"}]}
]' "3"

echo ""
echo "── Fixture: 2 PRs touching sensitive areas (should NOT trigger) ──"
run_case "2 sensitive PRs < CLUSTER_THRESHOLD" \
'[
  {"number":1,"mergedAt":"2026-05-10T10:00:00Z","files":[{"path":"src/permissions/manager.ts"}]},
  {"number":2,"mergedAt":"2026-05-11T10:00:00Z","files":[{"path":"src/audit/logger.ts"}]}
]' "2"

echo ""
echo "── Fixture: PRs with __tests__ only (should NOT count as sensitive hit) ──"
run_case "__tests__ paths excluded by caller logic (jq counts them; exclusion is bash-side)" \
'[
  {"number":1,"mergedAt":"2026-05-10T10:00:00Z","files":[{"path":"src/permissions/__tests__/foo.test.ts"}]},
  {"number":2,"mergedAt":"2026-05-11T10:00:00Z","files":[{"path":"src/audit/__tests__/bar.test.ts"}]}
]' "2"

echo ""
echo "── Fixture: PRs outside window (mergedAt < since) (should count 0) ──"
run_case "old PRs before SINCE_DATE not counted" \
'[
  {"number":1,"mergedAt":"2026-04-01T10:00:00Z","files":[{"path":"src/permissions/manager.ts"}]},
  {"number":2,"mergedAt":"2026-04-15T10:00:00Z","files":[{"path":"src/audit/logger.ts"}]},
  {"number":3,"mergedAt":"2026-04-30T10:00:00Z","files":[{"path":"src/ipc/handlers.ts"}]}
]' "0"

echo ""
echo "── Fixture: src/core/permissions (M2 addition) counted ──"
run_case "src/core/permissions counts as sensitive" \
'[
  {"number":1,"mergedAt":"2026-05-10T10:00:00Z","files":[{"path":"src/core/permissions/validator.ts"}]},
  {"number":2,"mergedAt":"2026-05-11T10:00:00Z","files":[{"path":"src/core/permissions/index.ts"}]},
  {"number":3,"mergedAt":"2026-05-12T10:00:00Z","files":[{"path":"src/core/permissions/policy.ts"}]}
]' "3"

echo ""
echo "── Fixture: src/preloader/ should NOT match src/preload ──"
run_case "preloader prefix does not over-match preload" \
'[
  {"number":1,"mergedAt":"2026-05-10T10:00:00Z","files":[{"path":"src/preloader/index.ts"}]},
  {"number":2,"mergedAt":"2026-05-11T10:00:00Z","files":[{"path":"src/preloader/utils.ts"}]},
  {"number":3,"mergedAt":"2026-05-12T10:00:00Z","files":[{"path":"src/preloader/bridge.ts"}]}
]' "0"

echo ""
echo "── Fixture: mix of sensitive + non-sensitive files in same PR ──"
run_case "PR with mixed files counts once" \
'[
  {"number":1,"mergedAt":"2026-05-10T10:00:00Z","files":[
    {"path":"src/permissions/manager.ts"},
    {"path":"src/ui/renderer/App.tsx"}
  ]},
  {"number":2,"mergedAt":"2026-05-11T10:00:00Z","files":[{"path":"src/ui/renderer/Chat.tsx"}]},
  {"number":3,"mergedAt":"2026-05-12T10:00:00Z","files":[{"path":"src/audit/logger.ts"}]}
]' "2"

echo ""
echo "────────────────────────────────────────────────────────────────────────"
echo "Results: ${PASS} passed, ${FAIL} failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
