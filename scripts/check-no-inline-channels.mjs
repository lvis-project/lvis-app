#!/usr/bin/env node
/**
 * check-no-inline-channels.mjs — #1409 C2 CI guard
 *
 * The chat / plugins / settings IPC domains must reference channel names ONLY
 * through the `src/contract/` SOT (`CHANNELS.*`), never as raw `"lvis:..."`
 * string literals. This scans exactly those three files and fails the build if
 * an inline channel literal reappears (regression guard for the C2 sweep).
 *
 * Scope is intentionally narrow: preload / other domains are swept in later
 * commits (C11+). Run standalone with `node scripts/check-no-inline-channels.mjs`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  "src/ipc/domains/chat.ts",
  "src/ipc/domains/plugins.ts",
  "src/ipc/domains/settings.ts",
];

// A quoted channel literal: an opening quote immediately followed by `lvis:`.
// Unquoted `lvis:...` in comments/JSDoc (e.g. "Covers: lvis:chat:*") is ignored.
const INLINE_CHANNEL = /["']lvis:/;

let violations = 0;
for (const rel of TARGETS) {
  const abs = join(process.cwd(), rel);
  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch (err) {
    console.error(`[no-inline-channels] cannot read ${rel}: ${err.message}`);
    process.exit(1);
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (INLINE_CHANNEL.test(lines[i])) {
      console.error(
        `[no-inline-channels] ${rel}:${i + 1} inline channel literal — use CHANNELS.* from src/contract/`,
      );
      console.error(`    ${lines[i].trim()}`);
      violations += 1;
    }
  }
}

if (violations > 0) {
  console.error(
    `[no-inline-channels] FAIL — ${violations} inline channel literal(s); route them through src/contract/app-contract.ts`,
  );
  process.exit(1);
}
console.log("[no-inline-channels] OK");
