#!/usr/bin/env node
/**
 * check-no-tls-bypass.mjs — §17 C1 CI guard
 *
 * dist/ 내 모든 JS/TS 파일에서 dev-only TLS bypass 패턴이 남아있는지 확인.
 * build 스크립트 끝에 체이닝되어 빌드를 fail시킨다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "ignore-certificate-errors",
  "PYTHONHTTPSVERIFY",
];
const DIST_DIR = join(process.cwd(), "dist");

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir doesn't exist — skip
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walk(p);
    } else if (/\.(js|mjs|cjs|ts)$/.test(entry)) {
      let content;
      try {
        content = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      for (const needle of FORBIDDEN) {
        if (content.includes(needle)) {
          console.error(`[tls-bypass-check] ${p} contains forbidden: ${needle}`);
          process.exitCode = 1;
        }
      }
    }
  }
}

try {
  walk(DIST_DIR);
} catch (e) {
  console.warn(`[tls-bypass-check] skipped: ${e.message}`);
}

if (process.exitCode === 1) {
  console.error("[tls-bypass-check] FAIL — dev-only TLS bypass detected in dist/");
  process.exit(1);
}
console.log("[tls-bypass-check] OK");
