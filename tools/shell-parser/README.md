# Packaged shell grammar

This directory builds the private runtime package in `resources/shell-parser`.
The pinned module in `go.mod` owns Bash grammar and typed JSON serialization.
`main.go` adds input, AST, output and parser recursion bounds. It retains full
original byte spans and adds source-indexed facts produced by the module's
`SplitBraces` and escaped-string expansion APIs. It does not execute commands.
Only static single-quoted escaped strings use expansion; variables, substitutions
and arithmetic are not evaluated by the bridge. Non-UTF-8 or NUL string results
remain unsupported at the host boundary.

Build with `node tools/shell-parser/build.mjs` using the pinned compiler. A build
copies the checksum-verified module into a private temporary directory; no patch
is applied to a shared module cache. Compiler/runtime versions, source inputs,
patched and original grammar bytes and generated asset digests are recorded in
`manifest.json`. Reinstall the local runtime dependency after rebuilding, before
loading or packaging the app. The loader verifies the installed asset digests.
The included parser/runtime licenses cover the bundled upstream source.

`exact-bash-lexing.patch` retains CR bytes as ordinary shell data and preserves
the end of a comment when its final backslash precedes a newline. It never
rewrites the command passed to the native shell. Remove that patch when an
upstream version passes the actual native comment-continuation and CR controls
without it. A dependency update must re-run both controls before changing the pin.

`logical-shell-input.patch` removes active escaped newlines in the existing
lexical reader before token classification and lookahead. Physical single-quoted
data, comments and quoted heredocs retain their bytes; backquoted commands keep
their outer lexical phase. Any quoted part of a heredoc delimiter suppresses body
expansion. The same reader records discarded byte ranges in a parse-owned
provenance map, which position arithmetic uses instead of assuming that a token's
logical width equals its original byte width. No host scanner or rewritten
executable source is involved. Lookahead and provenance storage are bounded by
the admitted source. The reusable parser retains its lookahead buffer; its
previous tree and provenance become eligible for collection after the next reset.
WASM linear memory may remain allocated after collection. There is no command or
analysis-result cache.
Remove this patch when the pinned upstream passes the retained native token,
quoted-data, original-span and reader-boundary controls without it.

`bounded-parser-recursion.patch` places a shared call-depth guard on every
recursive cycle in the pinned parser call graph: statement/word descent, test
expressions, arithmetic operators, heredoc quote removal and lexer recursion.
It aborts parsing through the parser's existing error path before a native
runtime stack trap; post-AST depth checks alone are insufficient. Keep this patch
until an upstream parser bound covers those cycles. Re-evaluate the call graph
and adversarial nesting corpus whenever the module changes. The guard counts
parser recursion frames, separately from the serialized AST depth ceiling.

`bounded-brace-work.patch` adds an explicitly bounded form of the module's brace
annotation helper. It charges constructed and copied parts before allocation,
with 200,000 part-work units shared across all execution words in one command.
This reuses the node ceiling's value, but counts annotation operations separately.
Sequence validation also charges the bytes joined by `Word.Lit` before that
allocation, using a separate 1 MiB budget. This contains the
helper's quadratic work when nested single-element or unclosed braces revert to
literal text. Exhaustion returns an analysis error and leaves the original word
untouched; it never reports that the input contains no expansion. Remove this
patch when the upstream helper exposes equivalent bounded work or a linear
algorithm, after re-running literal, active nested expansion and recovery controls.
Command arguments, finite loop items, ordinary redirect targets, unindexed array
items and naked declaration arguments receive brace annotations. Heredoc and
here-string data, scalar assignment values and test words do
not perform brace expansion; actual commands nested in them retain their own
argument roles. No work budget is spent on a literal data role.

Runtime initialization is asynchronous once per module instance and must finish
before synchronous policy imports become usable. There is no text/AST cache.
The one callback and runtime intentionally live for that module's lifetime;
per-call trees, copied brace words and serialization buffers are reclaimed by the
runtime. Missing assets, integrity failure or a runtime trap are initialization
or internal failures, never permission to fall back to a second parser.
