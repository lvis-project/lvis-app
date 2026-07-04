import path from 'node:path';
import fs from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execSync } from 'node:child_process';
import {
  hashReceiptFiles,
  listFilesRecursive,
  writeInstallReceipt,
} from '../../src/plugins/plugin-install-receipt.js';
import { canonicalJSON } from '../../src/plugins/whitelist/canonical-json.js';

/**
 * REAL plugin side-loader for the screenshot harness.
 *
 * Unlike `test/e2e/ui/fixtures.ts`'s `seedE2ePlugins`, which overwrites every
 * `ui[].entry` with an inert `"E2E Plugin UI"` stub (it only tests host-side
 * lifecycle wiring), this copies the plugin repo's REAL built `dist/` tree into
 * the isolated `~/.lvis/plugins/<id>/` so the plugin's actual UI bundle renders
 * inside the plugin webview. That is the whole point of the harness: capture
 * real plugin screens, not placeholder text.
 *
 * The plugin repos live as siblings of this app repo (or of any linked git
 * worktree) at `../lvis-plugin-<slug>/`. They ship a committed `dist/` (built
 * via `bun run build` in each repo), so no per-run build is required — the
 * harness copies the already-built bundle verbatim.
 *
 * Receipt verification (`plugin-install-receipt.ts`, enforced unconditionally
 * at load since the receipt-check-bypass removal) only validates the files it
 * lists — extra unlisted files in the plugin dir are not flagged — so the
 * receipt lists `plugin.json` + the host entry + every declared UI entry, while
 * the full `dist/` tree is copied so the UI bundle's own relative imports and
 * sibling assets resolve.
 */

type LaunchEnv = Record<string, string | undefined>;

/** Manifest shape we read the few fields we care about off of. */
interface PluginManifest {
  id?: unknown;
  version?: unknown;
  entry?: unknown;
  pluginAccess?: unknown;
  hostSecrets?: { read?: unknown };
  ui?: Array<{ entry?: unknown; kind?: unknown }>;
}

export interface SeededPluginEntry {
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: 'local-dev';
  approvedPluginAccess?: unknown;
}

function manifestIdentitySha256(manifestPath: string): string {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  return createHash('sha256').update(canonicalJSON(manifest)).digest('hex');
}

/**
 * Resolve where the sibling plugin repos live. Mirrors the resolution used by
 * `test/e2e/ui/fixtures.ts` so the two harnesses find the same checkouts:
 * `LVIS_E2E_PLUGIN_SOURCE_ROOT` override → this repo's parent → any linked git
 * worktree's parent, picking the first dir that actually contains a plugin repo.
 */
export function resolvePluginSourceRoot(repoRoot: string, probeSlug = 'lvis-plugin-local-indexer'): string {
  if (process.env.LVIS_E2E_PLUGIN_SOURCE_ROOT) {
    return path.resolve(process.env.LVIS_E2E_PLUGIN_SOURCE_ROOT);
  }
  const candidates = [path.resolve(repoRoot, '..')];
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    for (const line of output.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      candidates.push(path.dirname(line.slice('worktree '.length).trim()));
    }
  } catch {
    /* non-git checkout — fall back to repoRoot/.. */
  }
  const unique = [...new Set(candidates)];
  return (
    unique.find((c) => fs.existsSync(path.join(c, probeSlug, 'plugin.json'))) ?? unique[0]
  );
}

/** Map a manifest id (e.g. "local-indexer") to its sibling repo slug. */
function repoSlugForPlugin(id: string, sourceRoot: string): string | null {
  // Most repos are `lvis-plugin-<id>`; ms-graph/lge-api follow the same rule.
  const candidates = [`lvis-plugin-${id}`, id];
  for (const slug of candidates) {
    if (fs.existsSync(path.join(sourceRoot, slug, 'plugin.json'))) return slug;
  }
  // Fall back: scan every lvis-plugin-* dir and match on manifest id.
  try {
    for (const name of fs.readdirSync(sourceRoot)) {
      if (!name.startsWith('lvis-plugin-')) continue;
      const mp = path.join(sourceRoot, name, 'plugin.json');
      if (!fs.existsSync(mp)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as PluginManifest;
        if (m.id === id) return name;
      } catch {
        /* skip unparseable */
      }
    }
  } catch {
    /* sourceRoot unreadable */
  }
  return null;
}

/** Recursively copy a directory tree (built dist). */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

export interface SeedRealPluginsResult {
  /** Env vars (signed whitelist snapshot) to merge into the Electron launch env. */
  env: LaunchEnv;
  /** Plugin ids successfully seeded. */
  seeded: string[];
  /** Plugin ids requested but not found on disk (skipped, not fatal). */
  missing: string[];
}

/**
 * Copy the REAL built bundles of the requested plugins into the isolated
 * `~/.lvis/plugins/` and write the registry + receipts + signed whitelist
 * snapshot so the host loads them as local-dev installs at boot.
 *
 * @param pluginIds manifest ids to install (e.g. ["local-indexer", "meeting"]).
 */
export async function seedRealPlugins(
  repoRoot: string,
  lvisHomeForTest: string,
  pluginIds: readonly string[],
  opts: { disableReviewer?: boolean } = {},
): Promise<SeedRealPluginsResult> {
  const disableReviewer = opts.disableReviewer ?? true;
  const pluginsRoot = path.join(lvisHomeForTest, 'plugins');
  const cacheRoot = path.join(pluginsRoot, '.cache');
  fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });

  // Disable the LLM permission reviewer for plugin-panel captures.
  //
  // A plugin UI panel calls its read-category tools (index_documents,
  // meeting_list_preps, work_assistant_list_detectors, …) on mount. The default
  // reviewer is `mode:"llm"` following the active chat vendor; with the harness's
  // placeholder `plain:sk-e2e-*` key the reviewer LLM call errors, and
  // `fallbackOnError` classifies the invocation HIGH → a deferred "Approve Tool
  // Execution" modal covers the whole window, so the panel's own UI never
  // renders. Seeding `reviewer.mode:"disabled"` (post-#664 pass-through-LOW
  // semantics) makes those mount-time read calls classify LOW and run without a
  // modal, so the plugin's real panel paints. The `disabledMigratedAt` marker is
  // REQUIRED — without it `migrateLegacyDisabledMode` rewrites `disabled` →
  // `strict` (defer-all-HIGH) at load and the modal returns
  // (src/permissions/permission-settings-store.ts).
  // When `disableReviewer` is false the reviewer is left at its default (llm),
  // which — with the placeholder key — defers the plugin's mount-time read tool
  // to the "Approve Tool Execution" modal. That modal IS the capture target for
  // the `plugin-permission-grant` docs key, so that one scenario opts out here.
  if (disableReviewer) {
    const lvisHomeSettingsPath = path.join(lvisHomeForTest, 'settings.json');
    let lvisHomeSettings: Record<string, unknown> = {};
    try {
      // Read directly and treat ENOENT like malformed JSON — avoids the
      // exists-then-read TOCTOU race (CodeQL js/file-system-race).
      lvisHomeSettings = JSON.parse(fs.readFileSync(lvisHomeSettingsPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      lvisHomeSettings = {};
    }
    const existingPerms =
      (lvisHomeSettings.permissions as Record<string, unknown> | undefined) ?? {};
    lvisHomeSettings.permissions = {
      ...existingPerms,
      reviewer: {
        mode: 'disabled',
        disabledMigratedAt: new Date().toISOString(),
      },
    };
    fs.mkdirSync(path.dirname(lvisHomeSettingsPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lvisHomeSettingsPath, `${JSON.stringify(lvisHomeSettings, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  const sourceRoot = resolvePluginSourceRoot(repoRoot);
  const entries: SeededPluginEntry[] = [];
  const whitelistGrants: Record<string, { read: string[]; manifestSha256: string }> = {};
  const seeded: string[] = [];
  const missing: string[] = [];

  for (const pluginId of pluginIds) {
    const slug = repoSlugForPlugin(pluginId, sourceRoot);
    const sourceDir = slug ? path.join(sourceRoot, slug) : null;
    const sourceManifest = sourceDir ? path.join(sourceDir, 'plugin.json') : null;
    const sourceDist = sourceDir ? path.join(sourceDir, 'dist') : null;
    if (!sourceDir || !sourceManifest || !fs.existsSync(sourceManifest)) {
      console.warn(`[screenshots] plugin source missing, not seeded: ${pluginId} (looked under ${sourceRoot})`);
      missing.push(pluginId);
      continue;
    }
    if (!sourceDist || !fs.existsSync(sourceDist)) {
      console.warn(`[screenshots] plugin dist not built, not seeded: ${pluginId} (run 'bun run build' in ${sourceDir})`);
      missing.push(pluginId);
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(sourceManifest, 'utf-8')) as PluginManifest;
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
      console.warn(`[screenshots] invalid plugin manifest, not seeded: ${sourceManifest}`);
      missing.push(pluginId);
      continue;
    }

    const pluginDir = path.join(pluginsRoot, manifest.id);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });

    // Write the manifest with the `python` field stripped. Same reasoning as
    // test/e2e/ui/fixtures.ts (`delete base.python`): a host-managed Python
    // block makes the runtime require a lockfile + provisioned interpreter at
    // lifecycle start, which fails in the isolated profile and aborts the
    // plugin's start — so no UI provider registers and the panel never mounts.
    // The UI bundle itself needs no Python worker to render its empty state, so
    // dropping it lets the plugin start and expose its UI. The stripped
    // manifest is what the receipt + whitelist grant are computed against.
    const seededManifest = { ...(manifest as Record<string, unknown>) };
    delete seededManifest.python;
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    fs.writeFileSync(pluginJsonPath, `${JSON.stringify(seededManifest, null, 2)}\n`, 'utf-8');
    // Copy the ENTIRE built dist tree so UI bundle imports/assets resolve.
    copyDir(sourceDist, path.join(pluginDir, 'dist'));

    // Signed-whitelist grant for any host-secret reads the manifest declares
    // (local-indexer + meeting read llm.apiKey.*). No grant needed for plugins
    // with no hostSecrets.read (work-assistant).
    const hostSecretReads = Array.isArray(manifest.hostSecrets?.read)
      ? manifest.hostSecrets.read.filter((x): x is string => typeof x === 'string')
      : [];
    if (hostSecretReads.length > 0) {
      whitelistGrants[manifest.id] = {
        read: hostSecretReads,
        manifestSha256: manifestIdentitySha256(pluginJsonPath),
      };
    }

    // Receipt: list plugin.json + the entire copied dist tree so the integrity
    // check passes for the real files (matches what the host wrote at copy).
    const receiptFiles = ['plugin.json'];
    for (const file of await listFilesRecursive(path.join(pluginDir, 'dist'))) {
      receiptFiles.push(`dist/${file}`);
    }
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 2,
      pluginId: manifest.id,
      version: manifest.version,
      installSource: 'local-dev',
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date().toISOString(),
      files: await hashReceiptFiles(pluginDir, receiptFiles),
    });

    entries.push({
      id: manifest.id,
      manifestPath: `${manifest.id}/plugin.json`,
      enabled: true,
      installSource: 'local-dev',
      approvedPluginAccess: manifest.pluginAccess,
    });
    seeded.push(manifest.id);
  }

  fs.writeFileSync(
    path.join(pluginsRoot, 'registry.json'),
    `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`,
    'utf-8',
  );

  return {
    env: buildSignedWhitelistEnv(lvisHomeForTest, whitelistGrants),
    seeded,
    missing,
  };
}

/**
 * Build a signed marketplace-whitelist snapshot granting the declared
 * `hostSecrets.read` for each seeded plugin, plus the env vars that point the
 * host at it. Byte-for-byte the same construction as `test/e2e/ui/fixtures.ts`
 * `buildSignedWhitelistEnv` — kept here so the screenshot harness stays
 * independent of the e2e fixture module (which also seeds stub plugins).
 */
function buildSignedWhitelistEnv(
  lvisHomeForTest: string,
  grants: Record<string, { read: string[]; manifestSha256: string }>,
): LaunchEnv {
  if (Object.keys(grants).length === 0) return {};
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const doc = {
    version: 1,
    schemaVersion: 1,
    issuedAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    pluginGrants: Object.fromEntries(
      Object.entries(grants).map(([pluginId, grant]) => [
        pluginId,
        {
          publisher: 'screenshots',
          hostSecrets: { read: grant.read },
          approvedManifestSha256: grant.manifestSha256,
        },
      ]),
    ),
  };
  const body = JSON.stringify(doc);
  const envelope = {
    version: 1,
    iat: Math.floor(Date.now() / 1000),
    artifact_sha256: createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex'),
    signatures: [
      {
        key_id: 'whitelist-v1',
        alg: 'ed25519',
        sig: sign(null, Buffer.from(body, 'utf-8'), privateKey).toString('base64'),
      },
    ],
  };
  const whitelistPath = path.join(lvisHomeForTest, 'screenshots-marketplace-whitelist.demo.json');
  fs.writeFileSync(whitelistPath, body, 'utf-8');
  fs.writeFileSync(`${whitelistPath}.sig`, JSON.stringify(envelope), 'utf-8');
  return {
    LVIS_E2E_WHITELIST_SNAPSHOT_PATH: whitelistPath,
    LVIS_E2E_WHITELIST_PUBLIC_KEY: rawPublicKey.toString('base64'),
  };
}
