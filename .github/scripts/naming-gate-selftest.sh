#!/usr/bin/env bash
#
# Regression fixtures for `.github/scripts/naming-gate.sh`.
#
# The gate is a grep program whose value is entirely in which lines it does and
# does not match, and that is not visible by reading it. Each case below builds
# a throwaway git repository, commits a base, applies one edit, runs the real
# gate against that diff, and asserts BLOCK or PASS. Nothing is duplicated from
# the gate: the assertions are about behavior, so a change in the gate that
# alters behavior fails here.
#
# Each case names one of the gate's three outcomes, because they are not
# interchangeable: PASS is exit 0, BLOCK is exit 1 and means the gate matched a
# violation, ABORT is exit 2 or more and means the gate refused to decide. A
# harness that folded ABORT into BLOCK would score every BLOCK case green on a
# host where the gate cannot run at all — 19 vacuous passes on stock macOS,
# where `grep` has no `-P`. That is the same fail-open the gate itself aborts
# to avoid, so it is spelled out here rather than left to a non-zero test.
#
# Usage: naming-gate-selftest.sh [path/to/naming-gate.sh] [repo-root]
# Exit 0 when every case matches its expectation. `repo-root` is the checkout
# the allow-list liveness check reads; it defaults to this script's repository.

set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
gate="${1:-$here/naming-gate.sh}"
repo_root="${2:-$(cd "$here/../.." && pwd)}"

if [ ! -x "$gate" ]; then
  echo "FATAL: gate not executable at $gate"
  exit 1
fi
# Absolute, because every case runs the gate from inside its fixture directory.
# A relative path would resolve to nothing there, and a gate that fails to
# execute exits non-zero — which this harness would otherwise read as BLOCK and
# report as a passing assertion.
gate="$(cd "$(dirname "$gate")" && pwd)/$(basename "$gate")"

# The gate aborts on a `grep` without PCRE, so on such a host every case would
# reach that abort instead of the pattern it is meant to exercise. Refuse to
# report a score at all rather than print one that means nothing. The
# `grep-without-pcre-aborts` case below is unaffected: it shims a PCRE-less
# `grep` onto `PATH` inside its own fixture, so it does not depend on the host
# lacking one.
if ! printf 'a\n' | grep -qP 'a' 2>/dev/null; then
  echo "FATAL: naming-gate-selftest requires a grep with PCRE support (-P)."
  echo "       Stock macOS grep has none; install GNU grep or run this in CI."
  exit 2
fi

pass=0
fail=0
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT

# run_case <name> <PASS|BLOCK|ABORT> <base-setup-fn> <edit-fn>
#
# base-setup-fn writes the pre-change tree; edit-fn writes the change. Both run
# with the fixture repository as the working directory.
run_case() {
  local name="$1" expect="$2" setup="$3" edit="$4"
  local dir="$sandbox/$name"
  mkdir -p "$dir"
  (
    cd "$dir" || exit 1
    git init -q .
    git config user.email a@b.c
    git config user.name t
    git config commit.gpgsign false
    "$setup"
    git add -A
    git commit -qm base
    base=$(git rev-parse HEAD)
    "$edit"
    git add -A
    git commit -qm change
    "$gate" "$base" HEAD
  ) > "$sandbox/$name.log" 2>&1
  local code=$?
  if [ "$code" -eq 127 ]; then
    echo "  FAIL  $name: gate could not be executed"
    sed 's/^/        /' "$sandbox/$name.log"
    fail=$((fail + 1))
    return
  fi
  # 0 / 1 / >=2 are three different answers from the gate, not two. Collapsing
  # the last two would let a gate that died score as a gate that matched.
  local actual="PASS"
  [ "$code" -eq 1 ] && actual="BLOCK"
  [ "$code" -gt 1 ] && actual="ABORT"
  if [ "$actual" = "$expect" ]; then
    echo "  ok    $name ($actual)"
    pass=$((pass + 1))
  else
    echo "  FAIL  $name: expected $expect, got $actual"
    sed 's/^/        /' "$sandbox/$name.log"
    fail=$((fail + 1))
  fi
}

empty_base() { mkdir -p src; echo "export const a = 1;" > src/a.ts; }

# ---------------------------------------------------------------------------
# Process labels in code
# ---------------------------------------------------------------------------
edit_phase_label() { echo "// Phase 2b wrapper" >> src/a.ts; }
run_case "code-phase-label" BLOCK empty_base edit_phase_label

edit_h_label() { echo "// H2 wrapper" >> src/a.ts; }
run_case "code-h-label" BLOCK empty_base edit_h_label

edit_backticked_in_code() { echo 'const s = `Phase 2b`;' >> src/a.ts; }
run_case "code-backtick-is-not-a-mention" BLOCK empty_base edit_backticked_in_code

edit_domain_anchor() { echo "// see §4.5 and issue #811, Layer 3, Tier A" >> src/a.ts; }
run_case "code-domain-anchors-stay" PASS empty_base edit_domain_anchor

# ---------------------------------------------------------------------------
# Markdown: only the rule documents may name a banned token in backticks
# ---------------------------------------------------------------------------
doc_base() { mkdir -p docs/architecture; echo "# Design" > docs/architecture/design.md; printf '# Contract\n' > AGENTS.md; }

edit_doc_backticked() { echo 'The `H2 wrapper` and `Phase 2b` gate.' >> docs/architecture/design.md; }
run_case "shipped-doc-backticked-label" BLOCK doc_base edit_doc_backticked

edit_doc_bare() { echo 'The H2 wrapper and Phase 2b gate.' >> docs/architecture/design.md; }
run_case "shipped-doc-bare-label" BLOCK doc_base edit_doc_bare

edit_doc_fenced() { printf '```\nPhase 2b plan\n```\n' >> docs/architecture/design.md; }
run_case "shipped-doc-fenced-label" BLOCK doc_base edit_doc_fenced

edit_rule_doc_backticked() { echo 'Do not write `H2` or `Phase 2b`.' >> AGENTS.md; }
run_case "rule-doc-backticked-label" PASS doc_base edit_rule_doc_backticked

edit_rule_doc_bare() { echo 'Do not write H2 in prose.' >> AGENTS.md; }
run_case "rule-doc-bare-label" BLOCK doc_base edit_rule_doc_bare

# ---------------------------------------------------------------------------
# Test doubles: allowed names stay editable, new ones do not
# ---------------------------------------------------------------------------
double_base() {
  mkdir -p src web/components/landing
  echo "export class MockCloudIndexAdapter {}" > src/adapter.ts
  echo "function MockShell() { return null; }" > web/components/landing/workday.tsx
}

edit_touch_allowed_use() { echo "const a = new MockCloudIndexAdapter();" >> src/adapter.ts; }
run_case "allowed-double-stays-editable" PASS double_base edit_touch_allowed_use

edit_touch_allowed_jsx() { echo "const b = <MockShell kicker=\"x\" />;" >> web/components/landing/workday.tsx; }
run_case "allowed-double-in-web-stays-editable" PASS double_base edit_touch_allowed_jsx

edit_new_double() { echo "export class MockPaymentGateway {}" >> src/adapter.ts; }
run_case "new-double-blocks" BLOCK double_base edit_new_double

edit_new_fake() { echo "export class FakeClock {}" >> src/adapter.ts; }
run_case "new-fake-blocks" BLOCK double_base edit_new_fake

edit_derived_from_allowed() { echo "export function MockShellHeader() {}" >> src/adapter.ts; }
run_case "name-derived-from-an-allowed-one-blocks" BLOCK double_base edit_derived_from_allowed

edit_allowed_and_new_on_one_line() { echo "const c = new MockCloudIndexAdapter(); class MockBar {}" >> src/adapter.ts; }
run_case "allowed-name-does-not-shield-a-new-one" BLOCK double_base edit_allowed_and_new_on_one_line

edit_realpath_vocabulary() { echo "const realRoot = realpathSync(p); const stubText = BOUNDARY_STUB_TEMPLATE;" >> src/adapter.ts; }
run_case "realpath-and-compaction-vocabulary-pass" PASS double_base edit_realpath_vocabulary

# ---------------------------------------------------------------------------
# Filenames: decided once, on add or rename
# ---------------------------------------------------------------------------
existing_version_base() { mkdir -p docs/architecture; echo "old" > docs/architecture/session-model-v2.md; mkdir -p src; echo "x" > src/a.ts; }

edit_existing_version_file() { echo "one more line" >> docs/architecture/session-model-v2.md; }
run_case "grandfathered-version-name-stays-editable" PASS existing_version_base edit_existing_version_file

no_version_base() { mkdir -p docs/architecture; echo "d" > docs/architecture/overview.md; mkdir -p src; echo "x" > src/a.ts; }
edit_add_version_file() { echo "new" > docs/architecture/session-model-v2.md; }
run_case "new-version-suffix-without-sibling-blocks" BLOCK no_version_base edit_add_version_file

sibling_base() { mkdir -p src; echo "a" > src/engine.ts; echo "x" > src/a.ts; }
edit_add_version_sibling() { echo "b" > src/engine-v2.ts; }
run_case "version-suffix-with-live-sibling-passes" PASS sibling_base edit_add_version_sibling

edit_rename_into_double() { git mv src/a.ts src/mock-a.ts; }
run_case "rename-into-double-filename-blocks" BLOCK empty_base edit_rename_into_double

edit_add_double_file_with_header() {
  printf '// Why fake: this simulation is a shipped product mode.\nexport const x = 1;\n' > src/fake-network.ts
}
run_case "double-filename-with-why-header-passes" PASS empty_base edit_add_double_file_with_header

edit_add_double_file_without_header() { echo "export const x = 1;" > src/fake-network.ts; }
run_case "double-filename-without-why-header-blocks" BLOCK empty_base edit_add_double_file_without_header

# ---------------------------------------------------------------------------
# Excluded paths
# ---------------------------------------------------------------------------
test_base() { mkdir -p src/__tests__; echo "x" > src/__tests__/a.test.ts; mkdir -p src; echo "y" > src/a.ts; }
edit_in_tests() { echo "class MockThing {} // Phase 2b" >> src/__tests__/a.test.ts; }
run_case "tests-are-out-of-scope" PASS test_base edit_in_tests

edit_deletion_only() { rm src/a.ts; }
run_case "deletion-only-diff-passes" PASS empty_base edit_deletion_only

# ---------------------------------------------------------------------------
# A grep without PCRE must abort, not report clean
# ---------------------------------------------------------------------------
REAL_GREP=$(command -v grep)
pcreless_base() {
  mkdir -p src bin
  echo "export const a = 1;" > src/a.ts
  cat > bin/grep <<SHIM
#!/bin/sh
for arg in "\$@"; do
  case "\$arg" in
    -*P*) echo "grep: invalid option -- P" >&2; exit 2 ;;
  esac
done
exec $REAL_GREP "\$@"
SHIM
  chmod +x bin/grep
  export PATH="$PWD/bin:$PATH"
}
edit_clean_line() { echo "export const b = 2;" >> src/a.ts; }
run_case "grep-without-pcre-aborts" ABORT pcreless_base edit_clean_line

# ---------------------------------------------------------------------------
# A diff the gate cannot compute must abort, not report clean
#
# `run_case` always hands the gate a base it just committed, so it cannot reach
# this path. Driven directly instead: a base sha the fixture does not contain
# makes `git diff` fail, which once produced an empty file list and exit 0 —
# a gate that checked nothing and reported success.
# ---------------------------------------------------------------------------
echo ""
echo "unresolvable base sha:"
badbase_dir="$sandbox/unresolvable-base-sha"
mkdir -p "$badbase_dir"
(
  cd "$badbase_dir" || exit 1
  git init -q .
  git config user.email a@b.c
  git config user.name t
  git config commit.gpgsign false
  mkdir -p src
  echo "export const a = 1;" > src/a.ts
  git add -A
  git commit -qm base
  "$gate" 0000000000000000000000000000000000000000 HEAD
) > "$sandbox/unresolvable-base-sha.log" 2>&1
badbase_code=$?
if [ "$badbase_code" -eq 0 ]; then
  echo "  FAIL  unresolvable-base-sha-aborts: gate reported clean (exit 0) on a diff it could not compute"
  sed 's/^/        /' "$sandbox/unresolvable-base-sha.log"
  fail=$((fail + 1))
elif [ "$badbase_code" -eq 127 ]; then
  echo "  FAIL  unresolvable-base-sha-aborts: gate could not be executed"
  fail=$((fail + 1))
else
  echo "  ok    unresolvable-base-sha-aborts (exit $badbase_code)"
  pass=$((pass + 1))
fi

# ---------------------------------------------------------------------------
# The allow-list may not outlive the names it excuses
# ---------------------------------------------------------------------------
echo ""
echo "allow-list liveness (names must still exist in $repo_root):"
allow=$(grep -E "^MOCK_FAKE_ALLOWED=" "$gate" | sed -E "s/^MOCK_FAKE_ALLOWED='(.*)'$/\1/")
if [ -z "$allow" ]; then
  echo "  FAIL  could not read MOCK_FAKE_ALLOWED from $gate"
  fail=$((fail + 1))
else
  IFS='|' read -r -a allow_names <<< "$allow"
  for name in "${allow_names[@]}"; do
    if git -C "$repo_root" grep -qwE "$name" -- '*.ts' '*.tsx' 2>/dev/null; then
      echo "  ok    $name is still in the tree"
      pass=$((pass + 1))
    else
      echo "  FAIL  $name is allow-listed but no longer exists — remove it from the gate"
      fail=$((fail + 1))
    fi
  done
fi

echo ""
echo "naming-gate self-test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
