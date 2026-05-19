#!/usr/bin/env node
/**
 * encrypt-demo-credentials — CLI tool to turn a `.env.demo` plaintext file
 * into a single-line activation string that internal organization users can
 * paste into the LoginModal's activation input.
 *
 * Usage:
 *   npx tsx scripts/encrypt-demo-credentials.ts <path-to-.env.demo>
 *   npx tsx scripts/encrypt-demo-credentials.ts .env.demo
 *   npx tsx scripts/encrypt-demo-credentials.ts --in .env.demo --out activation.txt
 *
 * The tool reads the file, encrypts it with the same codec the main process
 * uses to decrypt (`src/main/demo-activation-codec.ts`), and prints the
 * activation string to stdout. With `--out`, the string is written to a
 * file instead.
 *
 * Why this script lives in `scripts/` rather than a published CLI:
 *   - It needs the *same* codec the app uses. Re-implementing the cipher in
 *     a separate package would create drift. Keeping it co-located ensures
 *     the encrypt path and decrypt path share a single source of truth.
 *   - It runs as a Node ESM script with no Electron dependency, so the CI
 *     pipeline that issues activation strings can invoke it without pulling
 *     in the full Electron build chain.
 *
 * NOTE: Invoke this script via `npx tsx scripts/encrypt-demo-credentials.ts`.
 * Node does not natively import `.ts` files, but `tsx` handles the on-the-fly
 * compile. The codec source is `src/main/demo-activation-codec.ts` and was
 * deliberately split out of the main-process-only module (no `fs`/`path`/
 * `lvisHome` imports) precisely so this CLI can pull it in without dragging
 * Electron-only paths into the script bundle.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { encryptActivationPayload } from "../src/main/demo-activation-codec.js";

interface ParsedArgs {
  input: string | null;
  output: string | null;
  help?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // Minimal arg parser — accepts `<path>` positional OR `--in <path> [--out <path>]`.
  const out: ParsedArgs = { input: null, output: null };
  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift();
    if (a === undefined) break;
    if (a === "--in") {
      out.input = args.shift() ?? null;
    } else if (a === "--out") {
      out.output = args.shift() ?? null;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (!out.input) {
      out.input = a;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      "encrypt-demo-credentials — encrypt a .env.demo file into an activation string",
      "",
      "Usage:",
      "  npx tsx scripts/encrypt-demo-credentials.ts <path-to-.env.demo>",
      "  npx tsx scripts/encrypt-demo-credentials.ts --in .env.demo --out activation.txt",
      "",
      "Output:",
      "  An LVIS-DEMO:v1:<base64url> string suitable for pasting into the",
      "  LoginModal's activation input. The string is single-line so it",
      "  copies cleanly through chat/Confluence/SharePoint.",
      "",
    ].join("\n"),
  );
}

const { input, output, help } = parseArgs(process.argv.slice(2));
if (help || !input) {
  printHelp();
  process.exit(help ? 0 : 1);
}

const inputPath = resolve(process.cwd(), input);
if (!existsSync(inputPath)) {
  process.stderr.write(`error: input file not found: ${inputPath}\n`);
  process.exit(1);
}

const plaintext = readFileSync(inputPath, "utf8");
if (plaintext.length === 0) {
  process.stderr.write(`error: input file is empty: ${inputPath}\n`);
  process.exit(1);
}

const activation = encryptActivationPayload(plaintext);

if (output) {
  writeFileSync(resolve(process.cwd(), output), `${activation}\n`, { mode: 0o600 });
  process.stdout.write(`wrote activation string to ${output}\n`);
} else {
  process.stdout.write(`${activation}\n`);
}
