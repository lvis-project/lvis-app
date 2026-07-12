/**
 * #885 Plugin Contract v6 (phase a4) — the ONE host reader of a tool's surface
 * visibility (SoT §2.3 / u2-host-consumers §0).
 *
 * All four consumer classes (validator, loader, projection, gate) read surface
 * membership through THIS primitive so no consumer re-implements the default or
 * the membership test. `parsePluginJson` (U1) is the SOLE defaulting site — it
 * materializes the STANDARD SEP-1865 default `["model","app"]` once at load, and
 * its output tools ALWAYS carry an explicit non-empty `_meta.ui.visibility`.
 * Therefore this host primitive is a pure READER, NOT a second defaulting site.
 */
import type { Tool as McpTool } from "../types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("plugin-runtime");

export type ToolSurface = "model" | "app";

/**
 * The MINIMAL GOVERNED surface, applied when a declaration is absent or malformed
 * on a path whose producer is contractually required to emit one.
 *
 * It denies app-invocability — so the tool can NEVER reach the ungoverned app-only
 * dispatch path (`isUiOnly` is false) — while staying LLM-reachable through the
 * governed executor. This is NOT the semantic default (that is the SEP-1865
 * `["model","app"]`, materialized only where a spec default legitimately applies:
 * `parsePluginJson` for manifests, `mcp-tool-adapter` for foreign servers).
 */
export const FAIL_CLOSED_SURFACE: readonly ToolSurface[] = ["model"];

/**
 * The ONE parser of a raw `_meta.ui.visibility` value — the membership test every
 * consumer class shares, whether the value arrived typed (a normalized manifest
 * `Tool`) or as an opaque wire `_meta` (`Record<string, unknown>` off `tools/list`).
 *
 * PURE and policy-free: returns the declared surfaces, or `null` when the value is
 * absent/empty/not an array of the two known literals. Each ingestion site then
 * applies its OWN documented policy for `null` (spec default vs fail-closed), which
 * is the only thing that legitimately differs between arms.
 */
export function parseToolSurfaces(raw: unknown): ToolSurface[] | null {
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => v === "model" || v === "app")
  ) {
    return raw as ToolSurface[];
  }
  return null;
}

/**
 * READ a tool's explicit surface visibility. The default (`["model","app"]`,
 * SEP-1865 standard, round-3) is materialized ONCE by parsePluginJson (U1) —
 * this function does NOT default. Post-normalize every tool carries an explicit
 * non-empty array, so the fall-through below is UNREACHABLE in the normal path.
 *
 * DEFENSIVE ASSERT (fail-closed): reaching the fall-through means a broken/absent
 * normalization step let a tool through with no explicit visibility. We resolve to
 * {@link FAIL_CLOSED_SURFACE} and warn loudly so the contract violation is visible
 * rather than silent.
 */
export function toolVisibility(tool: McpTool): ToolSurface[] {
  const parsed = parseToolSurfaces(tool._meta?.ui?.visibility);
  if (parsed) return parsed;
  log.warn(
    { event: "tool-visibility-missing", tool: tool.name },
    "tool reached a host consumer without explicit _meta.ui.visibility — " +
      "normalization-contract violation; applying fail-closed minimal surface [model]",
  );
  return [...FAIL_CLOSED_SURFACE];
}

export const isModelVisible = (t: McpTool): boolean => toolVisibility(t).includes("model");
export const isAppVisible = (t: McpTool): boolean => toolVisibility(t).includes("app");

/**
 * 1:1 restatement of SoT §2.3: `visibility.includes("app") && !visibility.includes("model")`.
 * The load-bearing #1554/#1556 governed-vs-bypass discriminator — a `model`-visible
 * tool (model-only or dual) is `isUiOnly === false` in every path, so it NEVER
 * reaches the `callDeclaredAppOnlyTool` bypass.
 */
export const isUiOnly = (t: McpTool): boolean => isAppVisible(t) && !isModelVisible(t);
