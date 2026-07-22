#!/usr/bin/env node

import { recoverOrphanedNativeReaper } from "./lib/electron-native-modules.mjs";

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const expectedToken = argumentValue("--expected-token");
const expectedGeneration = argumentValue("--expected-generation");
const confirmQuiesced = process.argv.includes("--confirm-quiesced");

try {
  const result = recoverOrphanedNativeReaper({
    repoRoot: process.cwd(),
    expectedToken,
    expectedGeneration,
    confirmQuiesced,
  });
  process.stdout.write(`Removed validated orphaned reaper: ${result.removed}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
