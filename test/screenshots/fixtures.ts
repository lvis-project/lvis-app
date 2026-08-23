import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  buildE2eBaseSettings,
  buildE2eSecrets,
  buildIsolatedElectronEnv,
  buildLlmSettings,
} from '../e2e/ui/seeded-electron.js';
import {
  REAL_PYTHON_CAPTURES,
  seedExecutionMode,
  seedRealPlugins,
  seedReviewerMode,
} from './plugin-seed.js';
import { PROVIDER_PING_SYSTEM_PROMPT } from '../../src/engine/turn/provider.js';
import { PERMISSION_REVIEWER_SYSTEM_PROMPT } from '../../src/shared/permission-reviewer-framework.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/**
 * Recursively hardlink a directory tree.
 *
 * Hardlinks — not a copy (633 MB per venv) and not a junction: near-instant,
 * no extra disk, and safe when the destination's parent (the isolated profile)
 * is recursively removed at teardown. `fs.rmSync` deletes the hardlink entries
 * but the SOURCE keeps its own directory entries, so the inodes survive and the
 * real provisioned venv is never wiped — unlike a junction, which `fs.rmSync`
 * can traverse into and delete the target contents of. Falls back to a copy per
 * file across volumes (EXDEV) or if the link cannot be created.
 */
function hardlinkTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      hardlinkTree(s, d);
    } else if (entry.isFile()) {
      try {
        fs.linkSync(s, d);
      } catch {
        fs.copyFileSync(s, d);
      }
    }
  }
}

/**
 * Opt-in real-Python reuse (`LVIS_SCREENSHOT_REAL_PYTHON=1`).
 *
 * A worker-backed plugin (local-indexer) only registers its live sidebar view
 * after its Python worker starts healthily, and the isolated profile has an
 * empty runtime cache — so without this it degrades to a Doctor entry. For each
 * seeded plugin that shipped a `python-requirements.lock` (plugin-seed copies it
 * only under this opt-in), find the venv the host ALREADY provisioned for that
 * exact lock under the REAL `~/.lvis/runtime` and hardlink it into the isolated
 * runtime at the path the host derives from the lock hash. The host's
 * PythonRuntimeBootstrapper then hits the `.ready` sentinel (no network, no
 * build) and the worker starts for real. No-op with a warning when no matching
 * venv exists — the capture then shows the Doctor entry, same as without the
 * opt-in. Machine-local by nature (relies on a prior real provisioning).
 */
function reuseRealPythonRuntime(lvisHomeForTest: string, seededIds: readonly string[]): void {
  const realEnvsRoot = path.join(os.homedir(), '.lvis', 'runtime', 'python-envs');
  if (!fs.existsSync(realEnvsRoot)) {
    console.warn(`[screenshots] real-python: no provisioned runtime at ${realEnvsRoot}`);
    return;
  }
  const realDirs = fs.readdirSync(realEnvsRoot);
  for (const id of seededIds) {
    const lockPath = path.join(lvisHomeForTest, 'plugins', id, 'python-requirements.lock');
    if (!fs.existsSync(lockPath)) continue;
    const lockHash = createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex').slice(0, 24);
    const match = realDirs.find(
      (d) => d.endsWith(`-py312-${lockHash}`) && fs.existsSync(path.join(realEnvsRoot, d, 'venv', '.ready')),
    );
    if (!match) {
      console.warn(
        `[screenshots] real-python: no ready venv for ${id} (lock ${lockHash}) — plugin will show a Doctor entry`,
      );
      continue;
    }
    const srcVenv = path.join(realEnvsRoot, match, 'venv');
    const destVenv = path.join(lvisHomeForTest, 'runtime', 'python-envs', match, 'venv');
    hardlinkTree(srcVenv, destVenv);
    // eslint-disable-next-line no-console
    console.log(`[screenshots] real-python: linked venv for ${id} -> ${destVenv}`);
  }
}

/**
 * Fixed capture viewport. Chosen independently of any single existing
 * screenshot (the current lvisai.xyz/public/screenshots/*.png assets have
 * inconsistent aspect ratios because each was cropped to its own target
 * element after capture — see README.md "Aspect ratio" section) — 1600x1000
 * gives enough width for the expanded work-mode rail plus a chat column
 * without clipping, and is large enough that per-key crops (locator
 * screenshots) still have full-resolution source pixels to crop from. A
 * scenario that needs a tighter frame overrides it per key — see the
 * `captureViewport` option below.
 */
export const CAPTURE_VIEWPORT = { width: 1600, height: 1000 } as const;

/** Window size for one capture, in CSS pixels. */
export interface CaptureViewport {
  width: number;
  height: number;
}

// ─── Scripted provider ────────────────────────────────────────────────────
//
// The conversational docs keys (streamed thinking, an in-flight tool call, an
// ask-user card, a permission deferral) only exist while a model turn is in
// flight, so before this the harness could not reach any of them and every
// `chat-*` scenario carried a skip. Rather than branch the host on a test-only
// provider, the harness starts a local OpenAI-compatible endpoint and points
// the seeded settings at it: `openai-compatible` is an API-key-optional vendor
// whose `baseUrl` is a normal user setting, and `selectProviderRuntimeFetch`
// already grants that exact origin loopback access
// (src/engine/llm/marketplace-provider-fetch.ts). Nothing under `src/` knows
// this endpoint exists — it is the same code path a self-hosted endpoint takes.
//
// Fail-closed by construction: a chat-completions request leaves the handler as
// the fixed connectivity-probe reply, a turn the script named, or an error.
// There is no fourth branch, and none of the three improvises an answer to what
// was asked. Every refused request is recorded on the handle, and the spec
// asserts that list is empty, so a script that no longer matches the host's call
// sequence fails the capture rather than producing a frame of the
// transport-error state.

/**
 * Model id the scripted endpoint serves.
 *
 * Nothing in the request handler reads the incoming `model` field — the endpoint
 * replays a script — so the value is free. It is not invisible, though: the
 * composer's status row prints
 * `<vendor> · <model>`, and a full-window capture of a `chat-*` key carries that
 * row into a published docs frame. So it is a neutral, self-describing name
 * rather than one that would put the capture harness's own identifiers on the
 * docs site.
 */
const SCRIPTED_PROVIDER_MODEL_ID = 'local-model';

/** One streamed piece of a scripted assistant turn. */
type ScriptedPart =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * Input fields holding a `seededCorpus` key, rewritten to that file's
       * absolute path inside the isolated profile before the script is served.
       * The profile lives in a per-run temp directory, so a scenario cannot
       * write the absolute path itself; naming the field here keeps the
       * substitution explicit instead of pattern-matching every string. An
       * unknown key throws rather than reaching the host as a relative path
       * the tool would reject.
       */
      seededPathFields?: readonly string[];
    };

/**
 * Which caller a scripted response answers. The host sends three shapes of
 * request through the same provider, told apart by their system prompt: the
 * conversation turn, the permission reviewer's classification call
 * (`PERMISSION_REVIEWER_SYSTEM_PROMPT`, sent verbatim by
 * `LlmRiskClassifier.runProviderWithRetry`), and `pingProvider`'s connectivity
 * probe (`PROVIDER_PING_SYSTEM_PROMPT`). Both markers are imported from the
 * modules that define them, so an edit to either prompt moves this check with
 * it. The probe is answered inline, before the queue is consulted at all — it
 * fires on a renderer-driven status check whose timing a capture must not
 * depend on.
 *
 * A conversation turn is anything else. That is the right default rather than a
 * third exact match: the assistant system prompt is assembled per session from
 * memory, skills and tool descriptions, so there is no fixed string to compare
 * it against.
 */
type ScriptedCaller = 'assistant' | 'reviewer';

export interface ScriptedTurn {
  parts: readonly ScriptedPart[];
  /**
   * Caller this entry answers. Checked against the classified request; a
   * mismatch is an error, not a silent re-order, so a script that no longer
   * matches the host's call sequence fails loudly.
   */
  expect?: ScriptedCaller;
  /** Delay between SSE chunks, so a capture can land mid-stream. */
  chunkDelayMs?: number;
}

/**
 * Wrapper around the transcript, because a Playwright fixture option cannot be
 * a bare array of objects: `isFixtureTuple` in playwright/lib/common/index.js
 * treats any `Array.isArray(value) && typeof value[1] === 'object'` as the
 * `[value, options]` registration tuple and silently keeps only `value[0]`.
 * A one-key object is never mistaken for that.
 */
export interface ScriptedScript {
  turns: readonly ScriptedTurn[];
}

export interface ScriptedProviderHandle {
  /** `http://127.0.0.1:<port>/v1` — what the seeded settings point at. */
  baseUrl: string;
  /** Requests the endpoint refused. Non-empty means the script drifted. */
  readonly violations: readonly string[];
  close(): Promise<void>;
}

/** Rewrite each declared seeded-path field to its absolute path. */
function resolveSeededPaths(
  turns: readonly ScriptedTurn[],
  lvisHome: string,
  seededCorpus: Readonly<Record<string, string>>,
): ScriptedTurn[] {
  return turns.map((turn) => ({
    ...turn,
    parts: turn.parts.map((part) => {
      if (part.kind !== 'tool' || !part.seededPathFields) return part;
      const input = { ...part.input };
      for (const field of part.seededPathFields) {
        const key = input[field];
        if (typeof key !== 'string' || !(key in seededCorpus)) {
          throw new Error(
            `scripted turn ${part.id}: "${field}" must name a seededCorpus entry (got ${JSON.stringify(key)})`,
          );
        }
        input[field] = path.join(lvisHome, key);
      }
      return { ...part, input };
    }),
  }));
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return sseData({
    id: SCRIPTED_PROVIDER_MODEL_ID,
    object: 'chat.completion.chunk',
    created: 0,
    model: SCRIPTED_PROVIDER_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/** Split on whitespace but keep it, so the replay streams word by word. */
function streamSegments(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A single scripted turn, as OpenAI-compatible SSE.
 *
 * `reasoning_content` is the field `@ai-sdk/openai-compatible` maps to a
 * `reasoning-delta` part (its chunk schema accepts `reasoning_content` and
 * `reasoning`), which `fullStreamToStreamEvent` turns into the host's
 * `reasoning_delta` event.
 */
async function writeTurn(
  res: http.ServerResponse,
  turn: ScriptedTurn,
): Promise<void> {
  const delay = turn.chunkDelayMs ?? 0;
  res.write(chunk({ role: 'assistant' }, null));
  let toolIndex = 0;
  let sawTool = false;
  for (const part of turn.parts) {
    if (part.kind === 'tool') {
      sawTool = true;
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: toolIndex,
                id: part.id,
                type: 'function',
                function: { name: part.name, arguments: JSON.stringify(part.input) },
              },
            ],
          },
          null,
        ),
      );
      toolIndex += 1;
      if (delay) await sleep(delay);
      continue;
    }
    const field = part.kind === 'reasoning' ? 'reasoning_content' : 'content';
    for (const segment of streamSegments(part.text)) {
      res.write(chunk({ [field]: segment }, null));
      if (delay) await sleep(delay);
    }
  }
  res.write(chunk({}, sawTool ? 'tool_calls' : 'stop'));
  res.write(
    sseData({
      id: SCRIPTED_PROVIDER_MODEL_ID,
      object: 'chat.completion.chunk',
      created: 0,
      model: SCRIPTED_PROVIDER_MODEL_ID,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function systemPromptOf(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  if (!Array.isArray(messages)) return '';
  const system = messages.find((m) => m.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

function callerOf(systemPrompt: string): ScriptedCaller {
  return systemPrompt === PERMISSION_REVIEWER_SYSTEM_PROMPT ? 'reviewer' : 'assistant';
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf-8');
}

/**
 * Start the scripted OpenAI-compatible endpoint on loopback.
 *
 * Bound to 127.0.0.1 with an ephemeral port: the guarded provider fetch the
 * host builds for a configured self-hosted base URL is locked to this exact
 * origin, so nothing else on the machine can be reached through it and it
 * reaches nothing else.
 */
async function startScriptedProvider(
  turns: readonly ScriptedTurn[],
): Promise<ScriptedProviderHandle> {
  const queue = [...turns];
  const violations: string[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: SCRIPTED_PROVIDER_MODEL_ID, object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
        violations.push(`unexpected request: ${req.method} ${url}`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `scripted provider serves POST /chat/completions only (got ${req.method} ${url})` } }));
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        violations.push(`unparseable request body: ${(err as Error).message}`);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'scripted provider received an unparseable body' } }));
        return;
      }

      const systemPrompt = systemPromptOf(body);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (systemPrompt === PROVIDER_PING_SYSTEM_PROMPT) {
        await writeTurn(res, { parts: [{ kind: 'text', text: 'PONG' }] });
        return;
      }

      const caller = callerOf(systemPrompt);
      const turn = queue.shift();
      if (!turn) {
        const message = `scripted provider ran out of turns — an unscripted ${caller} request arrived`;
        violations.push(message);
        res.write(sseData({ error: { message } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (turn.expect && turn.expect !== caller) {
        const message = `scripted provider expected a ${turn.expect} request, got ${caller}`;
        violations.push(message);
        res.write(sseData({ error: { message } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      await writeTurn(res, turn);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    violations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Seeded settings pointing the active vendor at the scripted endpoint.
 *
 * Built on top of `buildLlmSettings` so the vendor-block shape stays in
 * lockstep with the e2e suite's, with the base swapped for the harness's
 * locale and the one field `buildLlmSettings` does not model — `baseUrl` —
 * added for the selected vendor.
 */
function scriptedProviderSettings(
  baseUrl: string,
  locale: 'ko' | 'en',
): Record<string, unknown> {
  const built = buildLlmSettings('openai-compatible', SCRIPTED_PROVIDER_MODEL_ID) as {
    llm: { vendors: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  };
  const vendors = {
    ...built.llm.vendors,
    'openai-compatible': { ...built.llm.vendors['openai-compatible'], baseUrl },
  };
  return {
    ...buildE2eBaseSettings(true, locale),
    llm: { ...built.llm, vendors },
  };
}


export type ScreenshotFixtures = {
  app: ElectronApplication;
  mainWindow: Page;
  userDataDir: string;
  /** `LVIS_HOME` for the isolated profile — also one of the two default
   *  allowed directories, so seeded files under it are readable by tools. */
  lvisHome: string;
  /**
   * Null unless the scenario declared `scriptedScript`. When present the app was
   * launched against it and the spec asserts the handle recorded no refused
   * request. A turn the script still holds when the capture ends is not
   * checked — see the `violations` note in capture.spec.ts for why that
   * direction is deliberately one-way.
   */
  scriptedProvider: ScriptedProviderHandle | null;
};

export type ScreenshotOptions = {
  /**
   * Manifest ids of REAL plugins to side-load into the isolated profile before
   * launch (e.g. `['local-indexer']`). Their built `dist/` is copied from the
   * sibling `../lvis-plugin-<id>/` repo so their actual UI bundle renders — see
   * `plugin-seed.ts`. Empty (default) keeps the old behavior: no plugins, an
   * empty registry. Set per-scenario via `test.use({ installPlugins: [...] })`.
   */
  installPlugins: readonly string[];
  /**
   * Keep the LLM permission reviewer ON. By default seeding plugins disables it
   * (so panel mount-time read tools don't open the approval dock). The
   * `plugin-permission-grant` scenario sets this true because its capture target
   * IS that approval dock.
   */
  keepReviewer: boolean;
  /**
   * Transcript the local scripted endpoint replays, one entry per model call
   * the scenario drives. Null (default) leaves the app on its normal seeded
   * vendor with no endpoint running — the pre-existing behaviour for scenarios
   * that never start a turn.
   */
  scriptedScript: ScriptedScript | null;
  /**
   * `permissions.reviewer.mode` for the isolated profile, or null to leave the
   * host default (`llm`, following the active vendor). Plugin scenarios do not
   * set this — `seedRealPlugins` already picks the mode their panel needs.
   */
  reviewerMode: 'disabled' | 'rule' | 'llm' | 'strict' | null;
  /**
   * Permission execution mode written to the isolated profile's
   * `permissions.json`, or null to leave the host default (`default`).
   *
   * Only `auto` routes a foreground write/shell/network call through the
   * reviewer before the approval dock opens
   * (`PermissionManager.shouldRouteForegroundReviewer` requires
   * `mode === "auto"`); under `default` such a call reaches the dock straight
   * from the category rule, with no classification call in between.
   */
  executionMode: 'default' | 'strict' | 'auto' | 'allow' | null;
  /**
   * Fabricated files written under the isolated profile's LVIS home before
   * launch, keyed by path relative to it. That directory is one of the two
   * default allowed roots (`computeDefaultAllowedDirectories`), so a scripted
   * `read_file` over one of these runs without an approval prompt and the
   * frame shows invented content only.
   */
  seededCorpus: Readonly<Record<string, string>>;
  /**
   * UI locale for the capture. The published docs images are Korean, so
   * scenarios that replace one capture in Korean; `_smoke-settings-llm` and the
   * plugin-panel keys keep the harness's original English.
   */
  uiLocale: 'ko' | 'en';
  /**
   * Window size for this capture, or null for {@link CAPTURE_VIEWPORT}.
   *
   * The default is sized for the widest screens the harness has to fit (the
   * expanded work-mode rail plus a chat column). A key whose subject is a few
   * transcript rows fills a fraction of that, and the docs site scales the
   * whole frame down to its content width — so the subject arrives small
   * inside a large empty background. Naming a smaller window keeps the app's
   * real layout and just gives the subject less room to float in.
   */
  captureViewport: CaptureViewport | null;
};

/**
 * Electron launch fixture for the screenshot harness.
 *
 * Unlike `test/e2e/ui/fixtures.ts`'s `ElectronFixtures` (which seeds inert
 * `"E2E Plugin UI"` stubs to test host-side lifecycle wiring), this seeds the
 * plugin repos' REAL built UI bundles when a scenario opts in via
 * `test.use({ installPlugins: [...] })` — see `plugin-seed.ts`. Scenarios with
 * no `installPlugins` get an empty plugin registry (host-only screens).
 *
 * Reuses `buildE2eBaseSettings` / `buildE2eSecrets` / `buildIsolatedElectronEnv`
 * from the existing e2e harness (test/e2e/ui/seeded-electron.ts) so the test
 * LLM-key seeding and settings-file shape stay in lockstep with the suite
 * this harness sits next to, instead of drifting via a second copy.
 */
export const test = base.extend<ScreenshotFixtures & ScreenshotOptions>({
  installPlugins: [[], { option: true }],
  keepReviewer: [false, { option: true }],
  scriptedScript: [null, { option: true }],
  uiLocale: ['en', { option: true }],
  captureViewport: [null, { option: true }],
  reviewerMode: [null, { option: true }],
  executionMode: [null, { option: true }],
  seededCorpus: [{}, { option: true }],

  scriptedProvider: async ({ scriptedScript, lvisHome, seededCorpus }, use) => {
    if (!scriptedScript) {
      await use(null);
      return;
    }
    const handle = await startScriptedProvider(
      resolveSeededPaths(scriptedScript.turns, lvisHome, seededCorpus),
    );
    await use(handle);
    await handle.close();
  },

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvis-screenshot-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  lvisHome: async ({ userDataDir }, use) => {
    const dir = path.join(userDataDir, 'lvis-state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await use(dir);
  },

  app: async ({ userDataDir, lvisHome, installPlugins, keepReviewer, scriptedProvider, uiLocale, reviewerMode, executionMode, seededCorpus }, use) => {
    const mainEntry = path.join(REPO_ROOT, 'dist/src/main/main.js');
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `Electron main entry not found at ${mainEntry}. Run 'bun run build' before capturing screenshots.`,
      );
    }

    const lvisHomeForTest = lvisHome;

    // `system.appMode` is intentionally omitted — DEFAULT_APP_MODE ("work",
    // src/shared/initial-app-mode.ts) already matches the work-mode capture
    // requirement, and readPersistedAppModeSync falls back to it when the
    // settings file has no `system` block at all.
    fs.writeFileSync(
      path.join(userDataDir, 'lvis-settings.json'),
      `${JSON.stringify(
        scriptedProvider
          ? scriptedProviderSettings(scriptedProvider.baseUrl, uiLocale)
          : buildE2eBaseSettings(true, uiLocale),
        null,
        2,
      )}\n`,
      'utf-8',
    );
    // Seed a usable test LLM key so the composer is enabled for chat-* captures.
    fs.writeFileSync(
      path.join(userDataDir, 'lvis-secrets.json'),
      JSON.stringify(buildE2eSecrets(), null, 2) + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
    // Plugin registry. When `installPlugins` is empty (default) this writes an
    // empty registry — the original no-plugin behavior. When a scenario names
    // plugins, their REAL built `dist/` bundle is copied from the sibling repo
    // so the actual UI renders (see plugin-seed.ts), and a signed whitelist
    // snapshot is produced for any host-secret grants they declare.
    if (reviewerMode) seedReviewerMode(lvisHomeForTest, reviewerMode);
    if (executionMode) seedExecutionMode(lvisHomeForTest, executionMode);
    let pluginEnv: Record<string, string | undefined> = {};
    if (installPlugins.length === 0) {
      const pluginsRoot = path.join(lvisHomeForTest, 'plugins');
      fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(pluginsRoot, 'registry.json'),
        `${JSON.stringify({ version: 1, plugins: [] }, null, 2)}\n`,
        'utf-8',
      );
    } else {
      const result = await seedRealPlugins(REPO_ROOT, lvisHomeForTest, installPlugins, {
        disableReviewer: !keepReviewer,
      });
      pluginEnv = result.env;
      if (result.missing.length > 0) {
        // Surface missing bundles loudly — a scenario asked for a plugin whose
        // built dist is absent, so its capture will not be meaningful.
        console.warn(
          `[screenshots] requested plugins not seeded (bundle missing): ${result.missing.join(', ')}`,
        );
      }
      // Opt-in: make a worker-backed plugin's live panel capturable by reusing
      // the machine's pre-provisioned Python venv (see reuseRealPythonRuntime).
      if (REAL_PYTHON_CAPTURES) {
        reuseRealPythonRuntime(lvisHomeForTest, result.seeded);
      }
    }

    // Seeded corpus is written AFTER the plugin install, not before: installing
    // a plugin `rmSync`s its whole `plugins/<id>/` directory first (plugin-seed.ts),
    // so a scenario seeding a plugin's own data file — `plugins/meeting/data/preps.json`,
    // the store the upcoming-meeting panel lists — would have it deleted out from
    // under it. Ordinary corpus paths (`notes/...`) do not care either way, so one
    // ordering serves both rather than a second seeding hook for plugin data.
    for (const [relative, contents] of Object.entries(seededCorpus)) {
      const target = path.join(lvisHomeForTest, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, contents, { encoding: 'utf-8', mode: 0o600 });
    }

    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: buildIsolatedElectronEnv({
        ...pluginEnv,
        HOME: userDataDir,
        USERPROFILE: userDataDir,
        LVIS_DEV: '1',
        LVIS_E2E: '1',
        LVIS_HOME: lvisHomeForTest,
        NODE_ENV: 'test',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      }),
      timeout: 30_000,
    });
    app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron:stdout] ${d}`));
    app.process().stderr?.on('data', (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));
    await use(app);
    await app.close().catch(() => {});
  },

  mainWindow: async ({ app, captureViewport }, use) => {
    const win = await app.firstWindow();
    await win.setViewportSize(captureViewport ?? CAPTURE_VIEWPORT);
    await win.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    // Same overlay-neutralization as test/e2e/ui/fixtures.ts mainWindow fixture:
    // the post-tour first-task nudge is state-dependent and not something any
    // capture key wants floating over the shot.
    await win.addStyleTag({
      content: '[data-testid="post-tour-first-task"]{display:none !important;}',
    });
    // Deterministic captures: kill CSS transitions/animations globally so a
    // mid-tween frame is never captured, and hide the blinking caret. This is
    // a page.addStyleTag applied at the fixture level (not a src/** change) —
    // scoped to the screenshot harness only.
    await win.addStyleTag({
      content: `
        *, *::before, *::after {
          transition-duration: 0ms !important;
          animation-duration: 0ms !important;
          animation-delay: 0ms !important;
          caret-color: transparent !important;
        }
      `,
    });
    await use(win);
  },
});

export { expect };
export { REPO_ROOT };
