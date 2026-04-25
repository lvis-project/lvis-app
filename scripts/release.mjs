#!/usr/bin/env node
/**
 * Production release builder.
 *
 * Steps:
 *   1. Pre-flight security checks (H2 dev-key block, H3 signing-env validation)
 *   2. Read + patch-bump version in package.json
 *   3. bun run build (or npm fallback)
 *   4. Sign each packaged plugin's manifest (scripts/sign-manifest.mjs)
 *   5. electron-builder --publish=never → artifacts under ./release/
 *
 * Usage:  node scripts/release.mjs [--allow-dev-key] [--skip-code-sign]
 *
 * Credentials (signing certs, GH_TOKEN, etc.) must come from the environment
 * — never checked in. See docs/references/production-release-checklist.md.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgPath = resolve(root, "package.json");

const argv = process.argv.slice(2);
const ALLOW_DEV_KEY = argv.includes("--allow-dev-key");
const SKIP_CODE_SIGN = argv.includes("--skip-code-sign");
const IS_CI = process.env.CI === "true";

function run(cmd, args, opts = {}) {
  console.log(`[release] $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.error) {
    throw new Error(`${cmd} ${args.join(" ")} failed to spawn: ${r.error.message}`);
  }
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with code ${r.status}`);
  }
}

function bumpPatch(version) {
  const [maj, min, patch] = version.split(".").map((n) => parseInt(n, 10));
  if ([maj, min, patch].some(Number.isNaN)) {
    throw new Error(`Cannot parse version: ${version}`);
  }
  return `${maj}.${min}.${patch + 1}`;
}

/**
 * H2 — refuse to ship if the embedded publisher keys still include the
 * development key. Under CI without --allow-dev-key this is a hard failure.
 * Locally it prints a loud warning so the developer notices before upload.
 */
async function checkDevPublisherKey() {
  const pkKeysSrc = resolve(root, "src/plugins/publisher-keys.ts");
  if (!existsSync(pkKeysSrc)) {
    console.warn("[release] publisher-keys.ts not found — skipping dev-key check");
    return;
  }
  // Always parse the TypeScript source directly. Previously we tried
  // `dist/src/plugins/publisher-keys.js` first, but that can be stale —
  // a developer who edits the TS file without rebuilding would pass the
  // preflight even with the dev key reintroduced. The TS source is the
  // single source of truth for what the next `bun run build` will emit.
  const raw = readFileSync(pkKeysSrc, "utf-8");
  // Cheap heuristic: the dev-key constant contains "DEVELOPMENT" in its
  // name; if BUNDLED_PUBLISHER_PUBLIC_KEYS array literally references it we
  // treat that as "dev key embedded".
  const arrayRefsDev = /BUNDLED_PUBLISHER_PUBLIC_KEYS[^=]*=\s*\[[^\]]*DEVELOPMENT_PUBLISHER_PUBLIC_KEY_PEM[^\]]*\]/s.test(raw);
  if (!arrayRefsDev) return;
  const msg =
    "[release] SECURITY: BUNDLED_PUBLISHER_PUBLIC_KEYS still contains DEVELOPMENT_PUBLISHER_PUBLIC_KEY_PEM.\n" +
    "         Replace it with the production LGE publisher key before shipping.\n" +
    "         Re-run with --allow-dev-key only for internal dev snapshots.";
  if (IS_CI && !ALLOW_DEV_KEY) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

/**
 * H3 — validate signing environment. For packaged macOS/Windows builds we
 * need codesign material. --skip-code-sign is an explicit internal-build
 * opt-out. Also verifies package.json build.publish.provider is declared.
 */
function checkSigningEnv(pkg) {
  // Provider check — pkg.build.publish must exist AND have a known provider.
  const publish = pkg?.build?.publish;
  const provider = Array.isArray(publish) ? publish[0]?.provider : publish?.provider;
  const KNOWN_PROVIDERS = new Set(["github", "s3", "generic"]);
  if (!provider || !KNOWN_PROVIDERS.has(provider)) {
    const msg =
      `[release] package.json#build.publish.provider missing or unknown (got ${JSON.stringify(provider)}). ` +
      `Must be one of: ${[...KNOWN_PROVIDERS].join(", ")}.`;
    if (IS_CI) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
  }

  if (SKIP_CODE_SIGN) {
    console.warn("[release] --skip-code-sign — producing unsigned internal build");
    return;
  }

  const missing = [];
  if (process.platform === "darwin") {
    const hasCsc = process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD;
    const hasNotarize =
      process.env.APPLE_ID &&
      (process.env.APPLE_ID_PASSWORD || process.env.APPLE_APP_SPECIFIC_PASSWORD) &&
      process.env.APPLE_TEAM_ID;
    if (!hasCsc && !hasNotarize) {
      missing.push("macOS: CSC_LINK+CSC_KEY_PASSWORD OR APPLE_ID+APPLE_ID_PASSWORD+APPLE_TEAM_ID");
    }
  } else if (process.platform === "win32") {
    if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
      missing.push("Windows: CSC_LINK + CSC_KEY_PASSWORD");
    }
  }

  if (missing.length === 0) return;

  const msg =
    "[release] SECURITY: signing credentials not set. Required:\n  " +
    missing.join("\n  ") +
    "\n  Pass --skip-code-sign to opt out for internal builds.";
  if (IS_CI) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
}

async function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

  // Pre-flight security gates (fail CI early before any build work).
  await checkDevPublisherKey();
  checkSigningEnv(pkg);

  const oldVersion = pkg.version;
  const newVersion = process.env.LVIS_RELEASE_VERSION ?? bumpPatch(oldVersion);
  console.log(`[release] version: ${oldVersion} → ${newVersion}`);
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");

  const useBun = process.env.LVIS_USE_NPM !== "1" && existsSync(resolve(root, "bun.lockb"));
  run(useBun ? "bun" : "npm", ["run", useBun ? "build" : "build:npm"]);

  const signKey = process.env.LVIS_PUBLISHER_PRIVATE_KEY_PATH;
  if (signKey) {
    const pluginManifests = [
      "../lvis-plugin-pageindex/plugin.json",
      "../lvis-plugin-meeting/plugin.json",
      "../lvis-plugin-email/plugin.json",
      "../lvis-plugin-calendar/plugin.json",
    ];
    for (const rel of pluginManifests) {
      const abs = resolve(root, rel);
      if (!existsSync(abs)) continue;
      run("node", ["scripts/sign-manifest.mjs", abs]);
    }
  } else {
    console.warn("[release] LVIS_PUBLISHER_PRIVATE_KEY_PATH not set — skipping plugin signing");
  }

  run("npx", ["electron-builder", "--publish=never"]);

  console.log(`[release] done. Artifacts in release/  (version ${newVersion})`);
}

main().catch((err) => {
  console.error("[release] FAILED:", err);
  process.exit(1);
});
