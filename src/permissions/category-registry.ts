/**
 * Permission policy Layer 3 — Category Registry (Open-Closed pattern).
 *
 * Five canonical tool categories (`read | write | shell | network | meta`)
 * are described by {@link ToolCategoryDescriptor}s registered into a single
 * module-scoped map. PermissionManager.checkDetailed() looks up the
 * descriptor for the invocation's category and consults `decisionFor()`
 * for the {mode, source, headless} tuple.
 *
 * Design source: docs/architecture/permission-policy-design.md §3
 * Layer 3 + decision matrix table.
 *
 * Why a registry instead of a giant switch — a single source of truth
 * that:
 *   1. PermissionManager consults for every host-side category decision.
 *   2. #885 v6 — plugin `category` is REMOVED from the contract (Q3); the
 *      effective category is host-derived per invocation (`inspectHostRisk`).
 *      Filesystem path args are declared via `_meta["xyz.lvis/pathFields"]`.
 *      `meta` remains host-only.
 *   3. The reviewer classifier can score against `riskWeight`, the input
 *      to its baseline `final = max(rule, llm)` composition.
 *   4. Audit-schema consumers can iterate to enumerate the full decision
 *      matrix for forensics.
 *
 * Trust boundary: descriptor `decisionFor()` MUST be a pure function of
 * its inputs — no global state, no async I/O. Plugin code never executes
 * here. Only the host `registerStandardCategories()` populates the map.
 */
import type { ToolCategory, ToolSource } from "../tools/types.js";

export type CategoryDecision = "allow" | "ask" | "deny" | "reviewer" | "override";

export interface CategoryDecisionInput {
  mode: "default" | "auto" | "strict" | "allow";
  source: ToolSource;
  headless: boolean;
}

export interface ToolCategoryDescriptor {
  name: ToolCategory;
  /** 0..1 — rule classifier baseline weight. */
  riskWeight: number;
  /**
   * Pure function — given mode/source/headless, returns the lane the
   * executor should follow. `meta` returns the `"override"` sentinel so
   * the executor reads `tool.decisionOverride` instead.
   */
  decisionFor: (input: CategoryDecisionInput) => CategoryDecision;
}

const _registry = new Map<ToolCategory, ToolCategoryDescriptor>();

export function registerToolCategory(d: ToolCategoryDescriptor): void {
  _registry.set(d.name, d);
}

export function getToolCategoryDescriptor(name: ToolCategory): ToolCategoryDescriptor {
  const d = _registry.get(name);
  if (!d) {
    throw new Error(
      `Unknown tool category '${name}' — registry uninitialized or category missing. ` +
      `Call registerStandardCategories() at boot before tool registration.`,
    );
  }
  return d;
}

export function listKnownCategories(): ToolCategory[] {
  return Array.from(_registry.keys());
}

export function clearCategoryRegistry(): void {
  _registry.clear();
}

/**
 * Standard 5-axis registration. Boot wires this once before any tool
 * registration so {@link getToolCategoryDescriptor} cannot miss.
 *
 * Decision lanes (permission-policy-design.md §3 matrix table):
 *
 *   - read    — built-in: allow / plugin: allow (scope-checked elsewhere)
 *               strict mode forces ask, including headless.
 *   - write   — default+strict: ask / auto: reviewer at executor / allow: allow+audit /
 *               default+auto headless: reviewer / strict headless: ask
 *   - shell   — default+strict: ask / auto: reviewer at executor / allow: allow.
 *               Bash AST validation is executor-owned.
 *               default+auto headless: reviewer / strict headless: ask
 *   - network — default+strict: ask / auto: reviewer at executor / allow: allow+audit /
 *               default+auto headless: reviewer / strict headless: ask.
 *   - meta    — `decisionOverride` sentinel; executor short-circuits.
 */
export function registerStandardCategories(): void {
  registerToolCategory({
    name: "read",
    riskWeight: 0.1,
    decisionFor: ({ mode }) => (mode === "strict" ? "ask" : "allow"),
  });

  registerToolCategory({
    name: "write",
    riskWeight: 0.6,
    decisionFor: ({ mode, headless }) => {
      if (mode === "allow") return "allow";
      if (mode === "strict") return "ask";
      if (headless) return "reviewer";
      return "ask";
    },
  });

  registerToolCategory({
    name: "shell",
    riskWeight: 0.9,
    decisionFor: ({ mode, headless }) => {
      if (mode === "allow") return "allow";
      if (mode === "strict") return "ask";
      if (headless) return "reviewer";
      return "ask";
    },
  });

  registerToolCategory({
    name: "network",
    riskWeight: 0.7,
    decisionFor: ({ mode, headless }) => {
      if (mode === "allow") return "allow";
      if (mode === "strict") return "ask";
      if (headless) return "reviewer";
      return "ask";
    },
  });

  registerToolCategory({
    name: "meta",
    riskWeight: 0.0,
    decisionFor: () => "override",
  });
}

// Auto-register at module import — tests and ad-hoc callers that
// instantiate PermissionManager directly (without going through
// boot/conversation.ts) still get a populated registry. Boot still
// invokes registerStandardCategories() explicitly; these calls are
// idempotent.
registerStandardCategories();
