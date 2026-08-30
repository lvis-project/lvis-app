/**
 * LVIS-owned Grok Build PreToolUse policy hook.
 *
 * This entry point is started only from the canonical app-owned per-runtime
 * config.toml. It is intentionally standalone: it reads one bounded
 * hook event from stdin and writes one valid JSON decision to stdout. Grok
 * treats malformed hook output as fail-open, so every malformed or unexpected
 * input is an explicit deny from this process.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainRecord } from "../shared/is-record.js";

const MAX_INPUT_BYTES = 256 * 1024;
const ALLOWED_BRIDGE_TOOL = /^lvis-host-tools__[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const MCP_CATALOG_SEARCH_TOOL = "search_tool";

export type GrokPreToolPolicyDecision = Readonly<{
  decision: "allow" | "deny";
  reason?: string;
}>;

const ALLOW: GrokPreToolPolicyDecision = Object.freeze({ decision: "allow" });
const DENY: GrokPreToolPolicyDecision = Object.freeze({
  decision: "deny",
  reason: "LVIS routes tools through its governed host bridge.",
});

/**
 * Allow only the one MCP namespace that SubscriptionToolBridge owns for the
 * active ACP session, plus Grok's catalog-only MCP discovery primitive. For
 * `use_tool`, Grok resolves the target before dispatching PreToolUse, so the
 * hook sees the real qualified tool name rather than the generic dispatcher.
 * Native tools and other MCP servers deny by default.
 */
export function decideGrokPreToolUse(value: unknown): GrokPreToolPolicyDecision {
  // Input validation on a policy boundary: the value is a hook event parsed
  // from another process's stdout, so the only shape this hook accepts is a
  // plain JSON object. Anything carrying a custom prototype arrived by a route
  // this hook does not model, and it denies rather than reading `toolName`.
  if (!isPlainRecord(value)) return DENY;
  const toolName = value.toolName;
  return typeof toolName === "string"
    && (toolName === MCP_CATALOG_SEARCH_TOOL || ALLOWED_BRIDGE_TOOL.test(toolName))
    ? ALLOW
    : DENY;
}

async function readBoundedStdin(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      byteLength += bytes.length;
      if (byteLength > MAX_INPUT_BYTES) return null;
      chunks.push(bytes);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeDecision(decision: GrokPreToolPolicyDecision): void {
  // Do not emit diagnostics to stdout: it is a decision-only protocol and
  // malformed stdout would cause Grok's hook dispatcher to fail open.
  try {
    process.stdout.write(JSON.stringify(decision));
  } catch {
    // A broken stdout cannot safely be recovered in this child. The parent
    // policy verifies this bundled entrypoint before the runtime is launched.
  }
}

/** Execute the one-shot hook protocol, always returning a decision object. */
export async function runGrokPreToolPolicyHook(): Promise<void> {
  const raw = await readBoundedStdin();
  if (raw === null) {
    writeDecision(DENY);
    return;
  }
  try {
    writeDecision(decideGrokPreToolUse(JSON.parse(raw)));
  } catch {
    writeDecision(DENY);
  }
}

export function isGrokPreToolPolicyHookEntrypoint(
  entry = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entry) return false;
  try {
    return resolve(entry) === resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isGrokPreToolPolicyHookEntrypoint()) {
  // Never use a non-zero exit to represent a deny. Grok treats handler
  // failures as fail-open, while the explicit JSON decision above is a deny.
  void runGrokPreToolPolicyHook().catch(() => {
    writeDecision(DENY);
  });
}
