/**
 * Same bridge as `smoke-live-model.mjs`, but for the CDP app suite.
 *
 * Decrypts the OpenRouter key the user configured in Settings (only readable
 * from a real Electron runtime) and runs the live Playwright specs with it in
 * the child environment. The fixture picks the variable up, swaps the fake
 * seeded key for the real one, and pins the isolated profile to OpenRouter —
 * so the app under test is the shipped main process talking to a real provider.
 *
 * Usage: bun run smoke:app
 */
import { app, safeStorage } from "electron";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_KEY = "llm.apiKey.openrouter";

// Without this, userData resolves to %APPDATA%/Electron and the store is empty.
app.setName("LVIS");

const STATUS_PATH = join(process.cwd(), "smoke-live-app.status.txt");
const lines = [];
function report(message) {
  lines.push(message);
  console.log(`[smoke:app] ${message}`);
  writeFileSync(STATUS_PATH, `${lines.join("\n")}\n`, "utf-8");
}

/**
 * Remove `secret` from `text`. Belt and braces: the report path must be unable
 * to emit the key even if a downstream tool echoes it.
 */
function redactSecret(text, secret) {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function fail(message) {
  report(`FAILED: ${message}`);
  app.exit(1);
}

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    return fail("OS encryption unavailable — the stored key cannot be decrypted.");
  }
  const secretsPath = join(app.getPath("userData"), "lvis-secrets.json");
  if (!existsSync(secretsPath)) {
    return fail(`no secret store at ${secretsPath} — configure a key in Settings first.`);
  }

  let apiKey;
  try {
    const stored = JSON.parse(readFileSync(secretsPath, "utf-8"))?.[SECRET_KEY];
    if (typeof stored !== "string" || stored.length === 0) {
      return fail(`${SECRET_KEY} is not set — add an OpenRouter key in Settings first.`);
    }
    apiKey = safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch (err) {
    return fail(`could not read ${SECRET_KEY}: ${err.message}`);
  }

  // The key never appears in a report — not its value, not its length.
  report(`decrypted ${SECRET_KEY} — launching app suite`);

  const args = process.argv.slice(2);
  const child = spawn(
    "bunx",
    ["playwright", "test", ...(args.length ? args : ["test/e2e/ui/live-model-turn.spec.ts"])],
    {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, LVIS_SMOKE_OPENROUTER_KEY: apiKey, E2E: "1" },
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", (code) => {
    report(`suite exited with code ${code}`);
    report("--- suite output ---");
    // The child's output is not trusted to be secret-free: a provider error can
    // quote the request, and OpenRouter's 402 body carries a key-scoped URL.
    // Redact before anything reaches the console or the status file.
    report(redactSecret(output.trimEnd(), apiKey));
    app.exit(code ?? 1);
  });
});
