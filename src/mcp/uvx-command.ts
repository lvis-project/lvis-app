import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { resolveUvTarget } from "../../scripts/uv-targets.mjs";
import { lvisHome } from "../shared/lvis-home.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface StdioSpawnCommand {
  command: string;
  args: string[];
}

export function resolveStdioSpawnCommand(command: string, args: string[] = []): StdioSpawnCommand {
  if (!isBareUvxCommand(command)) {
    return { command, args };
  }
  return {
    command: resolveBundledUvBinary(),
    args: ["tool", "run", ...args],
  };
}

function isBareUvxCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed === "uvx" || trimmed === "uvx.exe";
}

function resolveBundledUvBinary(): string {
  const uvTarget = resolveUvTarget(process.platform, process.arch);
  const isDev =
    !!(process as { defaultApp?: boolean }).defaultApp || !process.resourcesPath;

  if (isDev) {
    const uvPathCandidates = [
      path.join(__dirname, "..", "..", "resources", "uv", uvTarget.dir, uvTarget.bin),
      path.join(__dirname, "..", "..", "..", "resources", "uv", uvTarget.dir, uvTarget.bin),
    ];
    const uvPath = uvPathCandidates.find((candidate) => fs.existsSync(candidate));
    if (!uvPath) {
      throw new Error(
        `bundled uv binary not found. Checked: ${uvPathCandidates.join(", ")}. ` +
          `Run "npm run postinstall" or "node scripts/fetch-uv.mjs" first.`,
      );
    }
    return uvPath;
  }

  const packagedDir = path.join(process.resourcesPath, "uv", uvTarget.dir);
  const compressedBin = path.join(packagedDir, `${uvTarget.bin}.gz`);
  const metaPath = path.join(packagedDir, "uv.meta.json");
  let binarySha256 = "unverified";
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { binarySha256?: unknown };
    if (typeof meta.binarySha256 === "string" && meta.binarySha256.length > 0) {
      binarySha256 = meta.binarySha256;
    }
  } catch {
    // The compressed binary access below produces the actionable missing-file error.
  }

  const targetDir = path.join(lvisHome(), "runtime", "uv", uvTarget.dir, binarySha256);
  const targetBin = path.join(targetDir, uvTarget.bin);
  if (fs.existsSync(targetBin)) return targetBin;
  if (!fs.existsSync(compressedBin)) {
    throw new Error(`packaged uv archive not found: ${compressedBin}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetBin, gunzipSync(fs.readFileSync(compressedBin)), { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(targetBin, 0o700);
  }
  return targetBin;
}
