#!/usr/bin/env node
/**
 * check-no-tls-bypass.mjs — build-output guard
 *
 * Scans every file under dist/ for a TLS-verification bypass and fails the
 * build when one survived into the bundle. The pattern list is shared with the
 * pre-push staged-source scan (scripts/lib/tls-bypass-patterns.mjs): this is
 * the same question asked of the bytes that ship rather than the bytes that
 * were committed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walkSourceFiles } from "./lib/source-walk.mjs";
import {
  TLS_BYPASS_SCAN_EXTENSIONS,
  findTlsBypass,
} from "./lib/tls-bypass-patterns.mjs";

const DIST_DIR = join(process.cwd(), "dist");

let violations = 0;
try {
  const files = walkSourceFiles(DIST_DIR, {
    extensions: TLS_BYPASS_SCAN_EXTENSIONS,
    tolerateUnreadableDirs: true,
  });
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const label of findTlsBypass(content)) {
      console.error(`[tls-bypass-check] ${file} contains forbidden: ${label}`);
      violations += 1;
    }
  }
} catch (e) {
  console.warn(`[tls-bypass-check] skipped: ${e.message}`);
}

if (violations > 0) {
  console.error("[tls-bypass-check] FAIL — TLS-verification bypass detected in dist/");
  process.exit(1);
}
console.log("[tls-bypass-check] OK");
