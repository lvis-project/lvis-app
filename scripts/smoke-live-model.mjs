/**
 * Bridge the app's stored OpenRouter key into the live-model smoke suite.
 *
 * The key the user typed into Settings is encrypted with Chromium OSCrypt and
 * is only readable from a real Electron runtime. The vitest runner is Electron
 * launched as plain node (ELECTRON_RUN_AS_NODE), where `safeStorage` does not
 * exist — so the suite takes its key from the environment instead, and this
 * script is the piece that runs under Electron proper, decrypts, and hands it
 * over.
 *
 * The secret is passed to the child through its environment. That keeps it out
 * of argv (visible in process listings) and off disk, but it is still a secret
 * in a child process on this machine — run this yourself, not on shared CI.
 *
 * Usage: bun run smoke:llm
 */
import { app, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = "llm.apiKey.openrouter";

// Without this the userData path is %APPDATA%/Electron and the store looks
// empty. `productName` in package.json is what the packaged app resolves to.
app.setName("LVIS");

/**
 * Electron on Windows is a GUI-subsystem binary, so stdout never reaches the
 * launching console. Every line also goes to a status file so a run is
 * observable either way.
 */
const STATUS_PATH = join(process.cwd(), "smoke-live-model.status.txt");
const lines = [];
function report(message) {
  lines.push(message);
  console.log(`[smoke:llm] ${message}`);
  writeFileSync(STATUS_PATH, `${lines.join("\n")}\n`, "utf-8");
}

function fail(message) {
  report(`FAILED: ${message}`);
  app.exit(1);
}

function readStoredKey() {
  if (!safeStorage.isEncryptionAvailable()) {
    return fail("OS encryption unavailable — the stored key cannot be decrypted.");
  }
  const secretsPath = join(app.getPath("userData"), "lvis-secrets.json");
  if (!existsSync(secretsPath)) {
    return fail(`no secret store at ${secretsPath} — configure a key in Settings first.`);
  }
  const stored = JSON.parse(readFileSync(secretsPath, "utf-8"))?.[SECRET_KEY];
  if (typeof stored !== "string" || stored.length === 0) {
    return fail(`${SECRET_KEY} is not set — add an OpenRouter key in Settings first.`);
  }
  return safeStorage.decryptString(Buffer.from(stored, "base64"));
}

// Not top-level await: Electron's main-process ESM loader does not run the
// module body to completion before the app starts, and a top-level await here
// silently produced no output at all.
app.whenReady().then(() => {
  let apiKey;
  try {
    apiKey = readStoredKey();
  } catch (err) {
    return fail(`could not read ${SECRET_KEY}: ${err.message}`);
  }
  if (!apiKey) return;

  // Shape, never the value.
  report(`decrypted ${SECRET_KEY} (${apiKey.length} chars) — running suite`);

  const child = spawn(
    "bun",
    ["run", "test:vitest", "--", "test/smoke/live-model.smoke.test.ts"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, LVIS_SMOKE_OPENROUTER_KEY: apiKey },
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", (code) => {
    report(`suite exited with code ${code}`);
    report("--- suite output ---");
    report(output.trimEnd());
    app.exit(code ?? 1);
  });
});
