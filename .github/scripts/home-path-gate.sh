#!/usr/bin/env bash
#
# Personal home path gate — a whole-tree scan, not a diff scan.
#
# This repository is public. An absolute home path carries the account name of
# whoever wrote it, and a path like the one a checkout sits under carries the
# directory layout of that machine as well. Both are permanent once pushed.
#
# The `deidentification-gate` job next to this one matches employer vocabulary
# on ADDED lines only, so it grandfathers whatever already sits in the tree.
# That is the right shape for a brand name, where the backlog is prose someone
# has to rewrite. It is the wrong shape here: a home path is mechanical to
# replace, the tree is clean as of the commit that added this script, and a
# diff scan cannot tell a reviewer whether the tree is still clean. So this
# gate reads every tracked text file every run. If it passes, the whole tree is
# clean — not merely the part of it this PR touched.
#
# The rule is an allow-list, not a deny-list. A deny-list would need to know
# the account names of people who have not contributed yet. The allow-list
# instead names the synthetic accounts a fixture is permitted to use, and
# anything else fails — which is what makes a first-time contributor's real
# account name fail on its first appearance.
#
# POSIX ERE only, matching the sibling gates: `grep -P` is absent from some
# builds, and a grep that rejects its own flag exits non-zero, which an
# `if grep ...` reads as "no match" and waves the violation through.
#
# Usage:
#   home-path-gate.sh [repo-root]     scan the tree (default: this repository)
#   home-path-gate.sh --selftest      prove the scan blocks and passes correctly
#
# Exit 0 clean, 1 violations found, 2 the gate could not decide.

set -uo pipefail

# Synthetic account names a tracked absolute path may use. Compared
# case-insensitively, so `Example` (kept where a test exercises case folding)
# needs no separate entry. Add to this list only for a name that cannot be a
# real person's account: if you are tempted to add one that could be, the fix
# is to rename the fixture instead.
ALLOWED_ACCOUNTS=(
  example user users me you owner runner
  test tester testuser dev demo
  alice bob carol dave victim attacker
  u x y z foo bar baz
  secret secretuser sensitive-project outside-home
  lvis lvis-app
  '...'
  'secret.txt'
)

# Which files this gate reads, expressed as what it SKIPS rather than what it
# accepts. An allow-list of extensions is the wrong shape here: a home path can
# be pasted into a Dockerfile, a lockfile, a .env, a plist or a Makefile, and
# every one of those is either extension-less or an extension nobody thought to
# list. Listing the binary formats instead is a closed set — a new source or
# config format is scanned by default, and only a genuinely unreadable one has
# to be added. A binary's *name* is covered by the sibling job's filename pass.
BINARY_FILE_RE='\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|mov|avi|node|dmg|exe|dll|so|dylib|class|jar|bin|wasm|db|sqlite3?|pyc|keystore|jks|p12|pfx)$'

# A home path, in every spelling this repository has actually carried:
#   /Users/<name>            macOS
#   /home/<name>             Linux
#   C:\Users\<name>          Windows, and `C:\\Users\\<name>` once escaped into
#                            a source string literal
#   C:/Users/<name>          Windows, slash-normalised
#   -Users-<name>-           the dash-encoded form an agent tool uses for a
#                            per-project state directory
SLASH_RE='(/Users/|/home/|[A-Za-z]:[\\/]{1,2}[Uu]sers[\\/]{1,2})[A-Za-z0-9_.-]+'
DASH_RE='-Users-[A-Za-z0-9_.]+'

is_allowed() {
  local candidate
  candidate=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  local allowed
  for allowed in "${ALLOWED_ACCOUNTS[@]}"; do
    [ "$candidate" = "$allowed" ] && return 0
  done
  return 1
}

# scan <repo-root> — prints every violation, returns 0 clean / 1 dirty / 2 abort.
scan() {
  local root="$1"
  cd "$root" || { echo "::error::cannot enter $root"; return 2; }

  local considered
  if ! considered=$(git ls-files | wc -l | tr -d ' '); then
    echo "::error::git ls-files failed — gate cannot verify this tree"
    return 2
  fi

  local hits status violations=0 file line rest name pattern strip
  # The two spellings are scanned separately because they end at different
  # separators. Folding them into one alternation and stripping at "any
  # separator" truncates a hyphenated placeholder — `sensitive-project` reads
  # as `project`, `outside-home` as `home` — and the gate then fails on names
  # its own allow-list contains.
  for pattern in "$SLASH_RE" "$DASH_RE"; do
    if [ "$pattern" = "$DASH_RE" ]; then strip='s|.*-||'; else strip='s|.*[\\/]||'; fi

    # One `git grep` over the whole index rather than a `grep` per file: the
    # per-file loop spawned two processes for every tracked file and took a
    # minute on this repository, which is long enough that someone eventually
    # moves the gate off the default path.
    #
    # `-a` forces text handling — a fixture holding a control byte otherwise
    # makes grep print "Binary file … matches" instead of the match, and that
    # is a hit the extraction cannot read.
    #
    # `-e` is mandatory, not stylistic: DASH_RE begins with `-`, and without
    # `-e` it is parsed as a bundle of flags whose tail becomes an entirely
    # different pattern. That misparse does not error — it silently matches
    # ordinary hyphenated words like `prefers-reduced-motion`, so the gate
    # would fail on a clean tree while still looking like it was working.
    if hits=$(git grep --no-color -a -n -o -E -e "$pattern" -- .); then
      status=0
    else
      status=$?
    fi
    if [ "$status" -ge 2 ]; then
      echo "::error::git grep failed (exit $status) — gate cannot verify this tree"
      return 2
    fi
    [ "$status" -eq 0 ] || continue

    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      file="${hit%%:*}"
      rest="${hit#*:}"
      line="${rest%%:*}"
      rest="${rest#*:}"
      # A binary's bytes are not searched; its *name* is what the sibling job
      # reads. Filtering here rather than in the pathspec keeps the skip rule
      # in one regex instead of splitting it across two syntaxes.
      printf '%s\n' "$file" | grep -qE -e "$BINARY_FILE_RE" && continue
      name=$(printf '%s' "$rest" | sed -E "$strip")
      [ -z "$name" ] && continue
      if ! is_allowed "$name"; then
        echo "::error file=$file,line=$line::personal account name in an absolute home path"
        echo "  $file:$line"
        violations=$((violations + 1))
      fi
    done <<< "$hits"
  done

  if [ "$violations" -gt 0 ]; then
    echo ""
    echo "::error::home-path-gate found $violations absolute home path(s) carrying a non-placeholder account name."
    echo "This repository is public, and a pushed path is permanent."
    echo "  fixture path   -> rebuild it on a synthetic account, or on os.homedir()/os.tmpdir()"
    echo "  comment        -> keep the example's shape, replace the identity"
    echo "  doc example    -> same"
    echo "The account names this gate accepts are listed at the top of"
    echo ".github/scripts/home-path-gate.sh; 'example' is the repository default."
    return 1
  fi

  echo "home-path-gate: clean ($considered tracked files considered)."
  return 0
}

# ---------------------------------------------------------------------------
# Self-test.
#
# A gate nobody has watched fail is not known to work, and this one is a grep
# program whose whole value is which lines it does and does not match. Each
# case builds a throwaway repository, runs the real scan over it, and asserts
# the outcome. Nothing here restates the gate's patterns, so a change to the
# gate that alters behaviour fails here rather than passing quietly.
#
# The violating account name is spliced into the path at run time and never
# appears as a literal in this file. Writing `/Users/<a real-looking name>`
# here would make this script its own first violation once the whole-tree scan
# reaches it, and the alternative — excluding the gate from its own scan — is a
# hole that grows every time someone edits the gate.
# ---------------------------------------------------------------------------

VIOLATING_ACCOUNT='mallory'

selftest() {
  local sandbox pass=0 fail=0
  sandbox=$(mktemp -d)
  trap 'rm -rf "$sandbox"' RETURN

  # run_case <name> <expected: PASS|BLOCK|ABORT> <writer-fn>
  run_case() {
    local name="$1" expect="$2" writer="$3"
    local dir="$sandbox/$name"
    mkdir -p "$dir"
    (
      cd "$dir" || exit 2
      git init -q .
      git config user.email a@b.c
      git config user.name t
      "$writer"
      git add -A
      git commit -qm base --no-verify
      scan "$dir"
    ) > "$sandbox/$name.log" 2>&1
    local code=$? actual
    case "$code" in
      0) actual=PASS ;;
      1) actual=BLOCK ;;
      *) actual=ABORT ;;
    esac
    if [ "$actual" = "$expect" ]; then
      echo "  ok    $name ($actual)"
      pass=$((pass + 1))
    else
      echo "  FAIL  $name: expected $expect, got $actual"
      sed 's/^/        /' "$sandbox/$name.log"
      fail=$((fail + 1))
    fi
  }

  w_clean_placeholder() {
    printf 'const home = "/Users/example/work";\n' > a.ts
    printf 'const linux = "/home/example/.aws";\n' >> a.ts
    printf 'const win = "C:\\\\Users\\\\example\\\\.ssh";\n' >> a.ts
    printf 'A doc mentioning `/Users/Example/Documents` for case folding.\n' > b.md
    # Ordinary hyphenated words. They are here because the dash-encoded
    # pattern begins with `-`: a grep invocation that lets it be read as flags
    # matches these instead, and only a clean-tree case notices.
    printf '@media (prefers-reduced-motion: reduce) { }\n' > c.css
    printf 'stats: "errors-warnings"\n' >> c.css
  }
  w_macos_violation() {
    w_clean_placeholder
    printf 'const mine = "/Users/%s/work";\n' "$VIOLATING_ACCOUNT" >> a.ts
  }
  w_linux_violation() {
    w_clean_placeholder
    printf 'const mine = "/home/%s/.aws";\n' "$VIOLATING_ACCOUNT" >> a.ts
  }
  w_windows_violation() {
    w_clean_placeholder
    printf 'const mine = "C:\\\\Users\\\\%s\\\\.ssh";\n' "$VIOLATING_ACCOUNT" >> a.ts
  }
  w_windows_slash_violation() {
    w_clean_placeholder
    printf 'const mine = "C:/Users/%s/.ssh";\n' "$VIOLATING_ACCOUNT" >> a.ts
  }
  w_dash_encoded_violation() {
    w_clean_placeholder
    printf 'state lives in -Users-%s-workspace-proj\n' "$VIOLATING_ACCOUNT" >> b.md
  }
  w_comment_violation() {
    w_clean_placeholder
    printf '// e.g. `list_files /Users/%s`\n' "$VIOLATING_ACCOUNT" >> a.ts
  }
  w_untracked_violation() {
    w_clean_placeholder
    # Written but never `git add`-ed by the case body? `git add -A` picks
    # everything up, so exclude it explicitly — the point is that the gate
    # reads the index, not the working directory.
    printf 'const mine = "/Users/%s/work";\n' "$VIOLATING_ACCOUNT" > scratch.ts
    printf 'scratch.ts\n' > .gitignore
  }
  w_binary_violation() {
    w_clean_placeholder
    # A `.png` is out of scope on purpose: its name is what the sibling job
    # reads. This case pins that boundary so a future change to
    # BINARY_FILE_RE is deliberate rather than accidental.
    printf 'const mine = "/Users/%s/work";\n' "$VIOLATING_ACCOUNT" > shot.png
  }
  w_extensionless_violation() {
    w_clean_placeholder
    # A Dockerfile has no extension, and neither do Makefile, .env or a
    # lockfile with an unfamiliar name. An extension allow-list would skip all
    # of them silently; this case is what makes the skip-list shape load-bearing
    # rather than a preference.
    printf 'WORKDIR /home/%s/app\n' "$VIOLATING_ACCOUNT" > Dockerfile
  }
  w_hyphenated_placeholder() {
    w_clean_placeholder
    # A placeholder containing a hyphen must be matched whole. Stripping at
    # "any separator" would read `outside-home` as `home`, which is not on the
    # allow-list, and the gate would fail on its own vocabulary.
    printf 'const a = "C:\\\\Users\\\\outside-home";\n' >> a.ts
    printf 'const b = "C:\\\\Users\\\\sensitive-project";\n' >> a.ts
    printf 'const c = "/home/lvis-app";\n' >> a.ts
  }
  w_tilde_lookalike() {
    w_clean_placeholder
    # `~/` is not a personal path and must never be flagged, or every shell
    # snippet in the docs becomes a violation.
    printf 'run `cp ~/.config/app.json /Users/example/backup`\n' >> b.md
  }

  echo "home-path-gate self-test:"
  run_case clean-placeholders-pass   PASS  w_clean_placeholder
  run_case macos-violation-blocks    BLOCK w_macos_violation
  run_case linux-violation-blocks    BLOCK w_linux_violation
  run_case windows-violation-blocks  BLOCK w_windows_violation
  run_case windows-slash-blocks      BLOCK w_windows_slash_violation
  run_case dash-encoded-blocks       BLOCK w_dash_encoded_violation
  run_case comment-violation-blocks  BLOCK w_comment_violation
  run_case untracked-file-ignored    PASS  w_untracked_violation
  run_case binary-out-of-scope       PASS  w_binary_violation
  run_case extensionless-blocks      BLOCK w_extensionless_violation
  run_case hyphenated-placeholder    PASS  w_hyphenated_placeholder
  run_case tilde-home-not-flagged    PASS  w_tilde_lookalike

  echo "  $pass passed, $fail failed"
  [ "$fail" -eq 0 ] || return 1
  return 0
}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case "${1:-}" in
  --selftest)
    selftest
    exit $?
    ;;
  "")
    scan "$(cd "$here/../.." && pwd)"
    exit $?
    ;;
  *)
    scan "$1"
    exit $?
    ;;
esac
