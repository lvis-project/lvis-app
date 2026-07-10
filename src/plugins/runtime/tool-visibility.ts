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
 * READ a tool's explicit surface visibility. The default (`["model","app"]`,
 * SEP-1865 standard, round-3) is materialized ONCE by parsePluginJson (U1) —
 * this function does NOT default. Post-normalize every tool carries an explicit
 * non-empty array, so the fall-through below is UNREACHABLE in the normal path.
 *
 * DEFENSIVE ASSERT (fail-closed): reaching the fall-through means a broken/absent
 * normalization step let a tool through with no explicit visibility. We resolve
 * to the MINIMAL GOVERNED surface `["model"]` — it denies app-invocability, so
 * the tool can NEVER reach the ungoverned app-only dispatch path (isUiOnly=false),
 * while staying LLM-reachable through the governed executor. This is NOT the
 * semantic default (that is `["model","app"]` and lives only in normalize); it
 * is a fail-closed backstop, and we warn loudly so the contract violation is
 * visible rather than silent.
 */
export function toolVisibility(tool: McpTool): ToolSurface[] {
  const raw = tool._meta?.ui?.visibility;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((v) => v === "model" || v === "app")
  ) {
    return raw as ToolSurface[];
  }
  log.warn(
    { event: "tool-visibility-missing", tool: tool.name },
    "tool reached a host consumer without explicit _meta.ui.visibility — " +
      "normalization-contract violation; applying fail-closed minimal surface [model]",
  );
  return ["model"]; // fail-closed minimal governed surface — NOT the default
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
