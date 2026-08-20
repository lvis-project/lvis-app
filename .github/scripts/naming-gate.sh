#!/usr/bin/env bash
#
# Naming gate — blocks NEW process-metadata in a PR diff.
#
# Usage: naming-gate.sh <base_sha> [head_rev]
#
# The rule this enforces, in positive form, is `AGENTS.md` > `Naming`. That
# document is the source of truth; this script is the subset of it a grep can
# decide. Anything grep cannot decide stays a reviewer rule there and is
# deliberately absent here — a check that cannot separate a domain word from a
# process word only teaches authors to argue with grep.
#
# Diff-based on purpose: existing violations are grandfathered and removed by
# separate sweep PRs. The job here is to stop new call sites.
#
# `.github/scripts/naming-gate-selftest.sh` pins every behavior below against
# synthetic diffs and runs in the same workflow. Change one, change the other.

set -uo pipefail

base_sha="${1:?usage: naming-gate.sh <base_sha> [head_rev]}"
head_rev="${2:-HEAD}"

# Fail closed on a grep without PCRE. Every identifier pattern below is run
# through `grep -P`; BSD/macOS grep rejects the option and exits 2, which the
# match loop would otherwise read as "no hits" and report a clean gate. A check
# that silently does nothing is worse than no check, so this is an abort.
if ! printf 'a\n' | grep -qP 'a' 2>/dev/null; then
  echo "::error::naming-gate requires a grep with PCRE support (-P). Install GNU grep or run this gate in CI."
  exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

exclude_re='^(docs/blueprints/|docs/ko/|\.github/|.*/__tests__/|.*/__mocks__/|test/|tests/|.*\.test\.|.*\.spec\.|.*\.lock|.*lock\.json|CHANGELOG)'
include_re='\.(ts|tsx|py|js|mjs|cjs|md)$'

# Content check: every changed file except DELETED ones (--diff-filter=d).
# A deletion cannot introduce a prohibited identifier.
git diff --name-only --diff-filter=d "$base_sha...$head_rev" \
  | grep -Ev "$exclude_re" \
  | grep -E "$include_re" > "$work/changed.txt" || true

# Filename check: ADDED and RENAMED files only (--diff-filter=AR).
# A file name is decided once, when the path first appears. Re-checking it on
# every later edit turns a grandfathered name into a permanent ban on touching
# that file at all — `docs/architecture/session-model-v2.md` is exactly that
# case in this tree. `R` is kept so a rename INTO a prohibited name is still
# caught.
git diff --name-only --diff-filter=AR "$base_sha...$head_rev" \
  | grep -Ev "$exclude_re" \
  | grep -E "$include_re" > "$work/added.txt" || true

echo "changed files:"
cat "$work/changed.txt"
echo "added/renamed files:"
cat "$work/added.txt"

violations=0

# `added.txt` (--diff-filter=AR) is a subset of `changed.txt` (--diff-filter=d,
# which excludes only deletions), so one emptiness test decides both.
if [ ! -s "$work/changed.txt" ]; then
  echo "no production-path file changes — skipping."
  exit 0
fi

# Review-round R is matched only with a hyphen (`R-2`) so domain risk-register
# ids (`R1`..`R8` in threat tables) are spared, and D-decision only with a
# colon (`D5:`) so bare `D1` identifiers and hex are spared. Permanent anchors
# (`#NNN` issue refs, `§9.6` architecture section refs) are intentionally NOT
# flagged: they resolve against a document the repository ships, which is what
# makes a label domain rather than process.
#
# `H[1-9]` is case-sensitive on purpose. HTML heading vocabulary in this tree
# is lowercase (`<h2`, 192 uses; zero uppercase `H2`), so it needs no carve-out.
#
# Test-double words: only `mock` and `fake` are matched as identifiers. `real`
# and `stub` are ordinary domain vocabulary here and are deliberately NOT
# matched — `real*` names a POSIX `realpath` result and `stub*` names a
# compaction stub. The old pattern was anchored on a lowercase first letter, so
# it could not match the `Mock*`/`Real*` class names the rule was written for
# and produced only false positives. `mock`/`fake` now match both spellings.
#
# They are NOT free of legitimate production uses, so the match is filtered
# through MOCK_FAKE_ALLOWED below rather than asserted to be clean.
patterns=(
  '\bH[1-9][0-9]?\b'
  '\bR-[1-9][0-9]?\b'
  '\bD[0-9]+:'
  '\bF-round\b'
  '\bPR-[A-Z][0-9]+\b'
  '\bPR#[0-9]+'
  '§M[1-9][0-9]?\b'
  '\b(MEDIUM|HIGH|CRITICAL|LOW)-[1-9][0-9]?\b'
  '\b[pP]hase[ -]?[0-9]+[a-z]?\b'
  '\bSprint [0-9A-Z]'
  '\bWave [0-9A-Z]'
  '\bW[0-9]\.[0-9]\b'
  '\b[rR]ound[0-9]+\b'
  '\b[tT]ier[0-9]+-(bypass|skip|excluded|ignored)'
  '\bpr[0-9]{3,}\b'
)

# Identifiers spelled `Mock*` that the tree uses in a domain sense, listed so
# the lines carrying them stay editable. Without this an existing name becomes
# a standing ban on touching its file — the identifier-level twin of the
# filename freeze the `--diff-filter=AR` narrowing above exists to prevent.
#
# The list is closed and enumerated, not a wildcard. A name that merely starts
# with an allowed one still blocks: the lookahead requires a word boundary
# after the allowed spelling, so `MockShellHeader` is matched and rejected
# while `MockShell` is not. `AGENTS.md` > `Naming` > `Test doubles` carries the
# same list with the reason for each, and the self-test asserts every entry
# still exists in the tree, so the list cannot outlive the names it excuses.
#
#   MockMarketplaceFetcher  dev-only catalog fetcher; the packaged build throws
#                           rather than construct it. "Mock" is the backend
#                           kind, the same axis as `CloudMarketplaceFetcher`.
#   MockCloudIndexAdapter   placeholder cloud adapter — this one IS named for
#                           what it is not, and is listed in `AGENTS.md` >
#                           `Known naming divergences` to be renamed. Allowed
#                           here so the rename is not blocked by its own edits.
#   MockShell               `web/` landing-page mock-UP frame, sibling of
#                           `mockup-frame.tsx`. A different word that happens
#                           to share four letters.
MOCK_FAKE_ALLOWED='MockMarketplaceFetcher|MockCloudIndexAdapter|MockShell'

# The two test-double patterns are built from that list with a PCRE negative
# lookahead rather than by deleting the words from the line first: a line that
# carries an allowed name AND a new one still fails on the new one. Lookahead
# is used because `sed -E '\b...'` is a GNU extension that silently matches
# nothing on BSD/macOS sed, which would make this gate behave differently for
# a developer running it locally than for CI.
patterns+=("\\b(?!(?:${MOCK_FAKE_ALLOWED})\\b)[Mm]ock[A-Z][A-Za-z0-9]*\\b")
patterns+=("\\b(?!(?:${MOCK_FAKE_ALLOWED})\\b)[Ff]ake[A-Z][A-Za-z0-9]*\\b")

# Markdown files whose job is to NAME the banned tokens. Only these get inline
# code spans stripped before matching: the rule documents have to be able to
# write `H2` and `Phase 2b` in order to ban them. Every other shipped `.md` is
# matched as-is, backticks included, because in an ordinary document a
# backticked `H2` is how the fossil actually appears in prose. Fenced blocks
# are never stripped anywhere, so a doc quoting a build log or git history
# inside ``` is matched too.
is_rule_document() {
  case "$1" in
    AGENTS.md|CLAUDE.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Added lines of one file, as the patterns see them.
added_lines() {
  local file="$1"
  local raw
  raw=$(git diff "$base_sha...$head_rev" -- "$file" | grep -E "^\+")
  if is_rule_document "$file"; then
    raw=$(printf '%s\n' "$raw" | sed 's/`[^`]*`//g')
  fi
  printf '%s\n' "$raw"
}

for pattern in "${patterns[@]}"; do
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    [ ! -f "$file" ] && continue
    added_lines "$file" | grep -Pn "$pattern" > "$work/hits.txt"
    grep_code=$?
    # 0 = matched, 1 = no match, anything else = grep itself failed. The last
    # case must not be read as "clean".
    if [ "$grep_code" -gt 1 ]; then
      echo "::error::grep failed (exit $grep_code) on pattern '$pattern' in $file"
      exit 2
    fi
    if [ "$grep_code" -eq 0 ] && [ -s "$work/hits.txt" ]; then
      echo "::error file=$file::process-metadata pattern '$pattern' added"
      cat "$work/hits.txt"
      violations=$((violations + $(wc -l < "$work/hits.txt")))
    fi
  done < "$work/changed.txt"
done

# filename-level checks — added and renamed files only
while IFS= read -r file; do
  [ -z "$file" ] && continue
  base=$(basename "$file")
  dir=$(dirname "$file")
  ext="${base##*.}"
  if echo "$base" | grep -qE '^(real|mock|fake|stub)-'; then
    # A leading test-double word names the file for what it is NOT — `real-x`
    # reads "the real one, as opposed to the other one". The identifier check
    # above drops `real`/`stub` because in an identifier those words are nouns
    # here (`realRoot` is a realpath result, `tool-result-stub.ts` is a
    # compaction stub); as a filename PREFIX they are adjectives and the
    # contrast is the whole meaning. The hatch is a `Why <prefix>:` header in
    # the first 30 lines, for a simulation the product deliberately ships. No
    # file in this tree carries one.
    if ! head -30 "$file" 2>/dev/null | grep -qE 'Why (real|mock|fake|stub):'; then
      echo "::error file=$file::new $base prefix in production path without 'Why <prefix>:' header justification"
      violations=$((violations + 1))
    fi
  fi
  if echo "$base" | grep -qE '\-v[0-9]+\.(ts|tsx|py|md)$'; then
    # A version suffix records WHEN the file was written unless the earlier
    # version is a live sibling beside it — only then does `-v2` say which of
    # two parallel implementations this is.
    stem=$(echo "$base" | sed -E "s/-v[0-9]+\.${ext}\$//")
    sibling=""
    if [ -f "$dir/$stem.$ext" ]; then
      sibling="$dir/$stem.$ext"
    else
      for cand in "$dir/$stem"-v[0-9]*."$ext"; do
        if [ -f "$cand" ] && [ "$cand" != "$file" ]; then
          sibling="$cand"
          break
        fi
      done
    fi
    if [ -n "$sibling" ]; then
      echo "note: $file keeps its version suffix — earlier sibling $sibling is live"
    else
      echo "::error file=$file::version-suffix filename with no earlier sibling in $dir — the suffix records when it was written, not what it is; use a behavior-based name"
      violations=$((violations + 1))
    fi
  fi
done < "$work/added.txt"

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "::error::naming-gate found $violations process-metadata violation(s)."
  echo "See AGENTS.md > Naming for the rule and the conversion guide."
  exit 1
fi

echo "naming-gate: clean."
