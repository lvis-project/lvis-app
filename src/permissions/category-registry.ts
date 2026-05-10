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
 *   2. Plugin manifest validation mirrors the plugin-facing subset
 *      (`read | write | shell | network`) in `manifest-validation.ts`;
 *      `meta` remains host-only and is not accepted from plugins.
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
  mode: "default" | "auto" | "strict";
  source: ToolSource;
  headless: boolean;
}

export interface ToolCategoryDescriptor {
  name: ToolCategory;
  /** 0..1 — Phase 3 rule classifier baseline weight. */
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
 *               strict mode forces ask. Headless reviewer if out-of-dir.
 *   - write   — default+strict: ask / auto: allow+audit / headless: reviewer
 *   - shell   — every mode: ask. Bash AST validation is executor-owned.
 *   - network — default+strict: ask / auto: allow+audit /
 *               headless: reviewer.
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
      if (headless) return "reviewer";
      if (mode === "auto") return "allow";
      return "ask";
    },
  });

  registerToolCategory({
    name: "shell",
    riskWeight: 0.9,
    decisionFor: ({ headless }) => (headless ? "reviewer" : "ask"),
  });

  registerToolCategory({
    name: "network",
    riskWeight: 0.7,
    decisionFor: ({ mode, headless }) => {
      if (headless) return "reviewer";
      if (mode === "auto") return "allow";
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
