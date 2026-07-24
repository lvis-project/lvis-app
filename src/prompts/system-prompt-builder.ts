



import { hostname, platform, userInfo } from "node:os";
import type { ActiveRolePrompt } from "../data/role-presets.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SkillCatalogEntry } from "../main/skill-store.js";
import type { ToolCatalogEntry, ToolRegistry, ToolSchemaEntry } from "../tools/registry.js";
import { redactFsPath } from "../audit/dlp-filter.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { isOverlayTriggerOrigin } from "../shared/overlay-trigger-source.js";
import { isAppMessageOrigin } from "../shared/mcp-app-message-source.js";
import { lvisHome } from "../shared/lvis-home.js";
import type { ProjectIdentity } from "../shared/project-identity.js";

const log = createLogger("system-prompt");

// ─── Types ──────────────────────────────────────────

type ToolProvenanceEntry = Pick<ToolSchemaEntry | ToolCatalogEntry, "source" | "pluginId" | "mcpServerId">;

type RequestablePluginCatalogCard = {
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  /** Enabled and loaded enough to be selectable via request_plugin. */
  active?: boolean;
  /** Runtime instance exists, so request_plugin can put it into turn scope. */
  runtimeLoaded?: boolean;
  loadStatus?: "loaded" | "preparing" | "failed" | "disabled";
};

function isRequestablePluginCatalogCard(
  card: RequestablePluginCatalogCard,
  activatablePluginIds?: ReadonlySet<string>,
): boolean {
  // A card with no exposable tools or no runtime instance can never be put
  // into turn scope, regardless of allow-listing.
  if (card.runtimeLoaded === false) return false;
  if (card.sampleTools.length === 0) return false;
  // Session-scoped on-demand activation — an allow-listed plugin the user has
  // toggled OFF is still activatable via request_plugin for THIS session
  // (its tools stay registered; only the per-turn scope hides them). List it as
  // requestable so the routine LLM can ask for it. Main chat passes no
  // allow-list ⇒ empty set ⇒ this branch never fires and disabled cards stay
  // hidden (behaviour unchanged).
  if (activatablePluginIds?.has(card.id)) return true;
  if (card.active === false) return false;
  if (card.loadStatus && card.loadStatus !== "loaded") return false;
  return true;
}

function toolProvenanceLabel(tool: ToolProvenanceEntry): string {
  if (tool.source === "plugin") return `plugin:${tool.pluginId ?? "unknown"}`;
  if (tool.source === "mcp") return `mcp:${tool.mcpServerId ?? "unknown"}`;
  return "builtin";
}

function renderToolGroups<T extends ToolProvenanceEntry>(
  entries: readonly T[],
  renderEntry: (entry: T) => string,
): string[] {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const label = toolProvenanceLabel(entry);
    const group = groups.get(label) ?? [];
    group.push(entry);
    groups.set(label, group);
  }

  const lines: string[] = [];
  for (const [label, group] of groups) {
    if (lines.length > 0) lines.push("");
    lines.push(`### ${label}`);
    for (const entry of group) lines.push(renderEntry(entry));
  }
  return lines;
}

export interface PromptSource {
  /** 소스 번호 (①~⑫) */
  id: number;
  /** 소스 이름 */
  name: string;
  /** 콘텐츠 생성 함수 — 빈 문자열이면 생략됨 */
  build: () => string;
  /** 갱신 주기 힌트 */
  refresh: "static" | "per-turn" | "on-change" | "conditional";
}

export interface SystemPromptBuilderDeps {
  memoryManager: MemoryManager;
  toolRegistry: ToolRegistry;
  /**
   * request_plugin candidate catalog provider. Empty/undefined omits the section.
   */
  getPluginCards?: () => RequestablePluginCatalogCard[];
  /**
   * Session-scoped on-demand activation allow-list. Plugin ids returned here are
   * treated as requestable in the catalog even when the user has toggled them
   * OFF (registry `enabled:false`), because the session can activate them via
   * request_plugin for its lifetime only. Routine sessions pass their
   * `allowedPluginIds`; main chat omits this (⇒ disabled plugins stay hidden).
   */
  getActivatablePluginIds?: () => ReadonlySet<string>;
  /**
   * Lightweight skill catalog provider. Only name/description are surfaced
   * here; full bodies stay behind `skill_load`.
   */
  getAvailableSkills?: () => SkillCatalogEntry[];
  /**
   * C2(c): current-turn SkillOverlay reader — returns the rendered
   * <lvis-active-skills>…</lvis-active-skills> section for the current
   * user turn, or "" when no skills have been loaded. Decoupled via this
   * callback so SystemPromptBuilder doesn't import the SkillOverlay module
   * (keeps the builder slim and testable).
   */
  getActiveSkillsSection?: (sessionId: string) => string;
  /**
   * MCP-app model context (`ui/update-model-context`) — returns the rendered
   * `<mcp-app-context>` section for the ACTIVE session's cards, or "" when no card has
   * pushed any. Decoupled through this callback exactly like `getActiveSkillsSection`:
   * the builder stays a pure assembler and never imports the store.
   *
   * This callback IS the "deferred to the next turn" semantic of the spec. The app writes
   * its slot whenever it likes; the model sees it only when the NEXT prompt is built, and
   * a write can never start a turn because nothing pushes — the builder PULLS.
   */
  getAppModelContext?: (sessionId: string) => string;
}

// ─── Builder ────────────────────────────────────────

export class SystemPromptBuilder {
  private readonly sources: PromptSource[] = [];
  private toolScope: {
    activePluginIds: Set<string>;
    /** Tool-Level Deferral — individually loaded plugin/mcp tool names. */
    activeToolNames?: Set<string>;
    includeBuiltins: boolean;
    includeMcp: boolean;
    /** Tool-Level Deferral — retained for persisted/test scope compatibility. */
    deferral?: boolean;
  } | null = null;
  private indexedDocsContext: string = "";
  private projectContext: ProjectIdentity | null = null;
  /**
   * Per-turn origin source (e.g., `overlay:meeting-detection`) — set by
   * ConversationLoop before a turn. When this matches `overlay:*`, the
   * Overlay Trigger Origin Guidance section emits a "validate first" instruction
   * so the LLM is prompted to second-guess the overlay-staged suggestion before
   * running tools.
   */
  private originSource: string | null = null;
  /**
   * C2(c): session id used to scope the active-skills overlay reader.
   * Set per-turn by ConversationLoop before `build()` so the overlay can
   * scope to the right session without leaking skills across sessions.
   */
  private overlaySessionId: string | null = null;
  private activeRolePrompt: ActiveRolePrompt | null = null;
  /**
   * Current session title injected as inert continuity context.
   * Title mutation is host-managed after the turn; the final answer must not
   * emit hidden title tags. Null when no title has been assigned yet.
   */
  private sessionTitle: string | null = null;
  /**
   * Rolling summary preamble from parent session checkpoint.
   * Set once on session load or explicit checkpoint fork so the LLM sees
   * accumulated prior context.
   * Cleared by clearSummaryPreamble().
   */
  private summaryPreamble: string | null = null;


  /**
   * Routine session mode flag (default false).
   * When true, the Routine Summary Tag Instruction section (id=9.8) is
   * included in the built prompt, instructing the LLM to append a
   * <summary>…</summary> tag at the end of its response. This tag is then
   * parsed by RoutineEngine to produce the OverlayCard summary — avoiding
   * raw truncation of full content.
   *
   * Must NOT be enabled on the main chat ConversationLoop — only set via
   * setRoutineMode(true) on the ConversationLoop instance created by
   * createRoutineConversationLoop().
   */
  private routineMode: boolean = false;

  constructor(deps: SystemPromptBuilderDeps) {
    this.initSources(deps);
  }

  /** 매 턴마다 호출 — 전체 시스템 프롬프트 조립 */
  build(): string {
    const sections: string[] = [];
    let preambleLen = 0;

    for (const source of this.sources) {
      const content = source.build();
      if (source.name === "Rolling Summary Preamble") {
        preambleLen = content.length;
      }
      if (content.trim()) {
        sections.push(content);
      }
    }

    if (preambleLen > 0) {
      log.info(`build: preamble injected (len=${preambleLen}, ${sections.length} sections total)`);
    }

    // Dev-only per-source size dump. Gated EXACTLY like LVIS_DEV_PREFLIGHT_OVERRIDE
    // in auto-compact.ts: ignored under production NODE_ENV, otherwise enabled when
    // LVIS_DEV_PROMPT_SOURCE_DUMP is set. Logs sizes/labels ONLY — never prompt
    // content — so memory/user content is not leaked into logs. Measurement
    // enabler for the TPM base-size work; no behavior change to the prompt itself.
    if (this.isPromptSourceDumpEnabled()) {
      const breakdown = this.getSourceSizeBreakdown();
      for (const entry of breakdown.sources) {
        log.info(
          `prompt-source-size: id=${entry.id} label=${JSON.stringify(entry.label)} chars=${entry.chars} estTokens=${entry.estTokens}`,
        );
      }
      log.info(
        `prompt-source-size: TOTAL chars=${breakdown.totalChars} estTokens=${breakdown.totalEstTokens} sources=${breakdown.sources.length}`,
      );
    }

    return sections.join("\n\n");
  }

  /**
   * Dev-only gate for the per-source size dump. Mirrors
   * `readDevPreflightOverride()` in auto-compact.ts: production NODE_ENV always
   * disables it; otherwise it is enabled when `LVIS_DEV_PROMPT_SOURCE_DUMP` is
   * set to a non-empty value.
   */
  private isPromptSourceDumpEnabled(): boolean {
    if (process.env.NODE_ENV === "production") return false;
    return Boolean(process.env.LVIS_DEV_PROMPT_SOURCE_DUMP);
  }

  /**
   * Pure per-source size breakdown of the assembled system prompt.
   *
   * Iterates the SAME source list `build()` concatenates — generically, with no
   * per-plugin/per-source branching — and reports the byte (char) and estimated
   * token cost of each non-empty source. Used to size which sources dominate the
   * per-round system-prompt base (loaded tool descriptions, input_schema,
   * memory, AGENTS.md, skills catalog, …) for the TPM base-size work.
   *
   * `totalChars` equals `build().length` for the same builder state so callers
   * can assert the per-source `chars` sum reconciles with the assembled prompt
   * (entries sum + "\n\n" join separators = totalChars).
   *
   * Pure: when `scope` is provided it is applied to the tool-scope only for the
   * duration of the measurement and restored before returning (no net state
   * change). When omitted, the current builder state is measured as-is.
   */
  getSourceSizeBreakdown(scope?: {
    activePluginIds: Set<string>;
    activeToolNames?: Set<string>;
    includeBuiltins: boolean;
    includeMcp: boolean;
    deferral?: boolean;
  } | null): {
    sources: Array<{ id: number; label: string; chars: number; estTokens: number }>;
    totalChars: number;
    totalEstTokens: number;
  } {
    const previousScope = this.toolScope;
    const scopeOverridden = scope !== undefined;
    if (scopeOverridden) this.toolScope = scope;
    try {
      const sources: Array<{ id: number; label: string; chars: number; estTokens: number }> = [];
      for (const source of this.sources) {
        const content = source.build();
        if (!content.trim()) continue;
        const chars = content.length;
        sources.push({
          id: source.id,
          label: source.name,
          chars,
          estTokens: estimateTokens(content),
        });
      }
      sources.sort((a, b) => b.chars - a.chars);
      // totalChars matches build().length: per-source chars + "\n\n" (2 chars)
      // join separators between the kept (non-empty) sections.
      const joinChars = sources.length > 1 ? (sources.length - 1) * 2 : 0;
      const totalChars = sources.reduce((sum, s) => sum + s.chars, 0) + joinChars;
      const totalEstTokens = sources.reduce((sum, s) => sum + s.estTokens, 0);
      return { sources, totalChars, totalEstTokens };
    } finally {
      if (scopeOverridden) this.toolScope = previousScope;
    }
  }

  /** 외부에서 소스 추가 */
  addSource(source: PromptSource): void {
    this.sources.push(source);
    this.sources.sort((a, b) => a.id - b.id);
  }

  /** 등록된 소스 목록 (디버깅용) */
  listSources(): Array<{ id: number; name: string; refresh: string }> {
    return this.sources.map((s) => ({ id: s.id, name: s.name, refresh: s.refresh }));
  }

  /** 인덱싱된 문서 정보를 시스템 프롬프트에 동적으로 업데이트 */
  setIndexedDocsContext(context: string): void {
    this.indexedDocsContext = context;
  }

  setProjectContext(project: ProjectIdentity | null): void {
    this.projectContext = project;
  }

  /**
   * 매 턴 직전 호출되어 Tool Schemas 섹션이
   * 노출할 tool 집합을 제한한다. null → 모든 도구 노출 (default 동작).
   */
  setToolScope(scope: {
    activePluginIds: Set<string>;
    activeToolNames?: Set<string>;
    includeBuiltins: boolean;
    includeMcp: boolean;
    deferral?: boolean;
  } | null): void {
    this.toolScope = scope;
  }

  /**
   * Per-turn origin tag. ConversationLoop sets this before `build()` so the
   * Overlay Trigger Origin Guidance section can emit "second-guess this trigger
   * before acting" instructions when the turn came from a user-accepted overlay
   * trigger request. Pass `null` to clear (default user-initiated turns).
   *
   * Empty string is normalized to null at the boundary so callers cannot
   * accidentally arm an empty overlay-trigger turn.
   */
  setOriginSource(source: string | null): void {
    this.originSource = source && source.length > 0 ? source : null;
  }

  /**
   * C2(c): per-round session id, used to scope the
   * <lvis-active-skills> overlay section to the correct ChatSession.
   * Pass `null` to clear (no overlay rendering).
   */
  setActiveSessionId(sessionId: string | null): void {
    this.overlaySessionId = sessionId && sessionId.length > 0 ? sessionId : null;
  }

  /**
   * Per-turn role prompt selected by the user in the composer. ConversationLoop
   * sets this immediately before build() and clears it immediately after.
   */
  setActiveRolePrompt(rolePrompt: ActiveRolePrompt | null): void {
    const prompt = rolePrompt?.systemPromptAdd.trim();
    if (!rolePrompt || !prompt) {
      this.activeRolePrompt = null;
      return;
    }
    this.activeRolePrompt = {
      name: this.sanitizeRoleName(rolePrompt.name),
      systemPromptAdd: prompt,
    };
  }

  /**
   * Per-turn session title. ConversationLoop sets this before
   * `build()` so the LLM can use the title as inert continuity context.
   * Pass `null` to clear (no title yet — first turn of a new session).
   */
  setSessionTitle(title: string | null): void {
    if (title === null) {
      this.sessionTitle = null;
      return;
    }
    const sanitized = this.sanitizeTitle(title);
    this.sessionTitle = sanitized.length > 0 ? sanitized : null;
  }

  /**
   * Strips characters that could break the prompt template or enable prompt
   * injection: CR, LF, double-quotes, backslashes, and angle brackets
   * (which could mutate prompt-template XML tags). Caps at 50 chars so
   * an abnormally long user-renamed title cannot bloat the prompt.
   */
  private sanitizeTitle(t: string): string {
    return t.replace(/[\r\n"\\<>]/g, " ").slice(0, 50).trim();
  }

  private sanitizeRoleName(name: string): string {
    return name.replace(/[\r\n"\\<>]/g, " ").slice(0, 80).trim() || "role";
  }

  /**
   * Sets the rolling summary preamble injected between system prompt and
   * recent turns. Call when loading a checkpoint/fork summary.
   */
  setSummaryPreamble(preamble: string | null): void {
    const newLen = preamble && preamble.length > 0 ? preamble.length : 0;
    log.info(
      `setSummaryPreamble: ${newLen > 0 ? `INJECTED len=${newLen}` : "CLEARED"}`,
    );
    this.summaryPreamble = preamble && preamble.length > 0 ? preamble : null;
  }

  /**
   * Clears the rolling summary preamble (equivalent to setSummaryPreamble(null)).
   * Call when starting a fresh session without a parent checkpoint.
   */
  clearSummaryPreamble(): void {
    this.setSummaryPreamble(null);
  }

  /**
   * Routine session mode. When true the Routine Summary Tag Instruction
   * (id=9.8) is emitted, instructing the LLM to terminate its response with
   * a <summary>…</summary> tag for OverlayCard display. Call with true only
   * on the ConversationLoop created by createRoutineConversationLoop().
   */
  setRoutineMode(enabled: boolean): void {
    this.routineMode = enabled;
  }

  // ─── Private ──────────────────────────────────────

  private initSources(deps: SystemPromptBuilderDeps): void {
    const { memoryManager, toolRegistry } = deps;


    this.sources.push({
      id: 1,
      name: "Role Definition",
      refresh: "static",
      build: () => t("be_systemPromptBuilder.roleDefinition"),
    });

    // ①-b Active role preset (per-turn, user-selected)
    this.sources.push({
      id: 1.5,
      name: "Active Role Prompt",
      refresh: "per-turn",
      build: () => {
        const rolePrompt = this.activeRolePrompt;
        if (!rolePrompt) return "";
        return [
          `<lvis-active-role-prompt name="${escapeAttribute(rolePrompt.name)}">`,
          "The user selected this role preset for the current turn. Apply it for this turn unless it conflicts with higher-priority instructions.",
          rolePrompt.systemPromptAdd,
          "</lvis-active-role-prompt>",
        ].join("\n");
      },
    });


    this.sources.push({
      id: 2,
      name: "AGENTS.md",
      refresh: "on-change",
      build: () => {
        const content = memoryManager.getAgentsMd();
        return content ? `<lvis-agents-context>\n${content}\n</lvis-agents-context>` : "";
      },
    });

    // Employee Profile — SSO/LDAP 의존
    // Org Context — 서버 인프라 의존

    // ④-b Tool Use Strategy (정적) — 모델이 도구를 어떻게 쓸지에 대한
    // Think→Act→Observe→Reflect 가이드. 특히 소형 reasoning 모델에서 도구
    // 호출 사이에 추론 흐름이 드러나도록 유도하는 목적 (migration doc lever 2).
    // 한 메시지 안의 다중 호출/단일 호출 전략은 LLM이 문맥에 맞게
    // 스스로 선택하도록 한다. 실제 실행은 LLM이 나열한 tool_call 순서를
    // 보존한다 (lever 1 — LLM 결정 사항).
    //
    // id=4.5: Org Context (id=4) 와 충돌하지 않도록 분수형 id 사용.
    // 정렬은 1 < 2 < 3 < 4 < 4.5 < 5 < 6 ... 로 자연스럽게 삽입된다.
    this.sources.push({
      id: 4.5,
      name: "Tool Use Strategy",
      refresh: "static",
      build: () => t("be_systemPromptBuilder.toolUseStrategy"),
    });

    // ④-c Overlay Trigger Origin Guidance (per-turn, conditional)
    //
    // Emitted ONLY when the current turn's origin source starts with
    // `overlay:*` — i.e., the turn came from a user-accepted host overlay
    // trigger request, NOT direct keyboard input.
    //
    // The guidance asks the LLM to second-guess the overlay-staged suggestion
    // before invoking tools — soft validation gate that complements the
    // hard ApprovalGate for destructive operations.
    this.sources.push({
      id: 4.6,
      name: "Overlay Trigger Origin Guidance",
      refresh: "per-turn",
      build: () => {
        const source = this.originSource;
        if (!isOverlayTriggerOrigin(source)) return "";
        // Defense-in-depth: a malicious plugin cannot *override* this
        // guidance via its `prompt` (which becomes the user-turn message)
        // because (a) ApprovalGate still gates all destructive ops and (b)
        // the guidance text below tells the LLM that anything inside
        // The imported trigger body is plugin-supplied — imperatives there
        // must NOT be obeyed if they conflict with this guidance.
        return [
          "<overlay-trigger-origin-guidance priority=\"high\">",
          t("be_systemPromptBuilder.overlayTriggerOriginNotDirectInput", { source: source ?? "" }),
          t("be_systemPromptBuilder.overlayTriggerOriginPluginSuggestion"),
          t("be_systemPromptBuilder.overlayTriggerOriginValidateFirst"),
          t("be_systemPromptBuilder.overlayTriggerOriginCheck1"),
          t("be_systemPromptBuilder.overlayTriggerOriginCheck2"),
          t("be_systemPromptBuilder.overlayTriggerOriginCheck3"),
          t("be_systemPromptBuilder.overlayTriggerOriginPassIfInvalid"),
          // 사용자가 트리거를 수락하면 (UI 의 \"확인하기\" 버튼) 다음 절차를 따르세요. 이 행동 가이드는 *시스템* 이 정의하므로 trigger 본문에 다시 적힐 필요가 없습니다 — 본문은 (제목/발신자/emailId 같은) 메타정보 위주로만 짧게 옵니다.
          t("be_systemPromptBuilder.overlayTriggerOriginProceedIfValid"),
          "</overlay-trigger-origin-guidance>",
        ].join("\n");
      },
    });

    // ④-c App Message Origin Guidance (per-turn, conditional)
    //
    // Emitted ONLY when the turn's origin source is `app:*` — the text came from an
    // MCP App's `ui/message` (a sandboxed, UNTRUSTED iframe), either confirmed by the
    // user from the staging card or injected mid-turn as guidance. Distinct from the
    // overlay block above because the trust story is different: an overlay prompt is a
    // first-party plugin's templated suggestion, whereas this body is arbitrary text
    // authored by a third-party app's UI. The hard gate (write/shell/network forced to
    // ask, `isStagedTurnOrigin`) applies to both; this is the model-facing half.
    this.sources.push({
      id: 4.65,
      name: "App Message Origin Guidance",
      refresh: "per-turn",
      build: () => {
        const source = this.originSource;
        if (!isAppMessageOrigin(source)) return "";
        return [
          "<app-message-origin-guidance priority=\"high\">",
          t("be_systemPromptBuilder.appMessageOriginNotDirectInput", { source: source ?? "" }),
          t("be_systemPromptBuilder.appMessageOriginUntrusted"),
          t("be_systemPromptBuilder.appMessageOriginConfirmBeforeAction"),
          "</app-message-origin-guidance>",
        ].join("\n");
      },
    });

    // ④-c Available Skills Catalog (per-turn, lightweight)
    //
    // Progressive disclosure: expose only dispatch metadata so the model can
    // decide whether a skill is relevant. Full bodies stay behind `skill_load`
    // and the body-hash approval gate.
    const { getAvailableSkills } = deps;
    if (getAvailableSkills) {
      this.sources.push({
        id: 4.65,
        name: "Available Skills Catalog",
        refresh: "per-turn",
        build: () => {
          const allSkills = getAvailableSkills();
          // Scope symmetry with tools (skill-loading-policy.md §1): only user
          // skills (no plugin owner) and skills whose owning plugin is in the
          // current turn scope are catalogued. An out-of-scope plugin's skill is
          // surfaced again once `request_plugin` brings its plugin into scope —
          // exactly as its Tools are. This removes the case where the model sees
          // (or loads) a skill that references Tools it currently cannot call.
          const activePluginIds = this.toolScope?.activePluginIds ?? new Set<string>();
          const inScope = allSkills.filter(
            (s) => !s.pluginOwner || activePluginIds.has(s.pluginOwner.pluginId),
          );
          if (inScope.length === 0) return "";
          // Deterministic priority: user skills first, then plugin skills;
          // alphabetical within each band. Query-relevance is intentionally NOT
          // applied to the resident catalog (skill-loading-policy.md §3): the
          // reference consensus (Claude Code / Codex / OpenCode) keeps the
          // catalog stable and lets the model narrow via skill_load, and
          // re-ordering it per turn would break Claude prompt-cache stable-prefix
          // reuse. Query scoring stays in the reactive skill_load/tool_search
          // path, not here.
          const ordered = inScope.slice().sort((a, b) => {
            const ap = a.pluginOwner ? 1 : 0;
            const bp = b.pluginOwner ? 1 : 0;
            if (ap !== bp) return ap - bp;
            return a.name.localeCompare(b.name);
          });
          // Token budget (skill-loading-policy.md §2): bound the always-present
          // metadata fixed cost, not just an entry count. The 80-entry cap stays
          // as a cheap pre-filter; the token budget is the authoritative bound.
          // At least one entry is always shown, and overflow stays reachable via
          // skill_list.
          const skills: SkillCatalogEntry[] = [];
          let catalogTokens = 0;
          for (const s of ordered) {
            if (skills.length >= MAX_SKILL_CATALOG_ENTRIES) break;
            const recordTokens = estimateTokens(renderSkillCatalogRecord(s));
            if (skills.length > 0 && catalogTokens + recordTokens > SKILL_CATALOG_TOKEN_BUDGET) {
              break;
            }
            skills.push(s);
            catalogTokens += recordTokens;
          }
          if (skills.length === 0) return "";
          const hiddenCount = Math.max(0, inScope.length - skills.length);
          const records = skills.map(renderSkillCatalogRecord);
          return [
            '<lvis-available-skills trust="untrusted-metadata">',
            t("be_systemPromptBuilder.skillsCatalogUntrustedMetadata"),
            t("be_systemPromptBuilder.skillsCatalogNoInstructions"),
            t("be_systemPromptBuilder.skillsCatalogDescriptionHint"),
            t("be_systemPromptBuilder.skillsCatalogLoadedBodyOnly"),
            "",
            "```json",
            "{",
            '  "skills": [',
            ...records.map((record, index) => `    ${record}${index === records.length - 1 ? "" : ","}`),
            "  ]",
            "}",
            "```",
            ...(hiddenCount > 0 ? [`${hiddenCount} more skills hidden; call skill_list to inspect the full catalog.`] : []),
            "</lvis-available-skills>",
          ].join("\n");
        },
      });
    }

    // ④-d Active Skills Overlay (per-turn while current user turn is active)
    //
    // C2(c): rendered ONLY when at least one skill has been loaded for the
    // current user turn. Bodies live inside <lvis-skill> fences so the LLM
    // can attribute the guidance and an attacker-supplied body cannot
    // masquerade as user input. See main/skill-overlay.ts for the registry.
    const { getActiveSkillsSection } = deps;
    if (getActiveSkillsSection) {
      this.sources.push({
        id: 4.7,
        name: "Active Skills Overlay",
        refresh: "per-turn",
        build: () => {
          const sid = this.overlaySessionId;
          if (!sid) return "";
          return getActiveSkillsSection(sid);
        },
      });
    }

    // ④-e MCP App Context (per-turn, only while a card in THIS session has pushed one)
    //
    // The `ui/update-model-context` slots of the active session's MCP-app cards. Read
    // HERE, at prompt build — which is what makes the spec's "deferred until the next
    // model turn" a structural fact rather than a policy: the app writes its slot through
    // a gated IPC that holds no reference to the conversation loop, and the content
    // surfaces only when the next turn is assembled. An app can never wake the model.
    //
    // The block itself is fenced and labelled by the store (mcp/mcp-app-model-context.ts)
    // as UNTRUSTED APP DATA — the same "data, never instructions" framing the App Message
    // Origin Guidance above and the skills catalog below already carry.
    const { getAppModelContext } = deps;
    if (getAppModelContext) {
      this.sources.push({
        id: 4.75,
        name: "MCP App Context",
        refresh: "per-turn",
        build: () => {
          const sid = this.overlaySessionId;
          if (!sid) return "";
          return getAppModelContext(sid);
        },
      });
    }

    // ⑤ Tool Schemas (매 턴)
    this.sources.push({
      id: 5,
      name: "Tool Schemas",
      refresh: "per-turn",
      build: () => {
        const scope = this.toolScope;
        const schemas = scope
          ? toolRegistry.getToolSchemasForScope(scope)
          : toolRegistry.getToolSchemas();
        if (schemas.length === 0) return "";
        return [
          "<available-tools>",
          t("be_systemPromptBuilder.toolSchemasAvailableIntro"),
          t("be_systemPromptBuilder.toolSchemasSourceNote"),
          "",
          ...renderToolGroups(schemas, (s) =>
            `- **${s.name}**: ${s.description}`,
          ),
          "</available-tools>",
        ].join("\n");
      },
    });

    // ⑤-b Tool Catalog (per-turn, Tool-Level Deferral)
    //
    // Lists in-scope plugin/MCP tools that are NOT loaded (deferred) as a
    // compact name + 1-line catalog. The model promotes a tool into the live
    // tool set by calling `tool_search({ query })`. Loaded tools (Source 5)
    // are excluded by getToolCatalogForScope, so no duplication.
    this.sources.push({
      id: 5.5,
      name: "Tool Catalog",
      refresh: "per-turn",
      build: () => {
        const scope = this.toolScope;
        if (!scope) return "";
        const catalog = toolRegistry.getToolCatalogForScope({
          activePluginIds: scope.activePluginIds,
          activeToolNames: scope.activeToolNames ?? new Set<string>(),
          includeMcp: scope.includeMcp,
          deferral: scope.deferral,
        });
        if (catalog.length === 0) return "";
        return [
          "<tool-catalog>",
          t("be_systemPromptBuilder.toolCatalogNotLoadedIntro"),
          t("be_systemPromptBuilder.toolCatalogGroupingNote"),
          "",
          ...renderToolGroups(catalog, (t) => `- **${t.name}**: ${t.description}`),
          "</tool-catalog>",
        ].join("\n");
      },
    });

    // request_plugin 카탈로그.
    // LLM이 "이 턴에 필요한 플러그인"을 판단해 request_plugin 호출 가능하도록
    // system prompt에 힌트를 노출. 현재 턴 scope에 이미 들어온 plugin과
    // 사용자/registry가 비활성화한 plugin은 제외한다.
    const { getPluginCards, getActivatablePluginIds } = deps;
    this.sources.push({
      id: 65,
      name: "Requestable Plugin Catalog",
      refresh: "per-turn",
      build: () => {
        const cards = getPluginCards?.() ?? [];
        if (cards.length === 0) return "";
        const active = this.toolScope?.activePluginIds ?? new Set<string>();
        const activatable = getActivatablePluginIds?.();
        const inactive = cards.filter((c) => !active.has(c.id) && isRequestablePluginCatalogCard(c, activatable));
        if (inactive.length === 0) return "";
        const lines: string[] = [
          t("be_systemPromptBuilder.requestablePluginCatalogHeader"),
        ];
        for (const c of inactive) {
          const sample = c.sampleTools.length > 0 ? `: ${c.sampleTools.join(", ")}` : "";
          lines.push(`- **${c.id}** — ${c.name}: ${c.description}${sample}`);
        }
        return lines.join("\n");
      },
    });

    // ⑦ Memory / notes / Indexed Docs (파일 변경 시)
    this.sources.push({
      id: 7,
      name: "Memory & Knowledge",
      refresh: "on-change",
      build: () => {
        const prefs = memoryManager.getUserPreferences();
        const memoryScope = this.projectContext?.projectRoot
          ? {
              projectRoot: this.projectContext.projectRoot,
              projectName: this.projectContext.projectName,
              includeUnscoped: this.projectContext.isDefault === true,
            }
          : undefined;
        const memoryIndex = memoryManager.getMemoryIndex(memoryScope);
        const notes = memoryManager.getMemoryContext(memoryScope);
        const parts: string[] = [];
        if (prefs) parts.push(`<user-preferences>\n${prefs}\n</user-preferences>`);
        if (memoryIndex) parts.push(`<lvis-memory-index>\n${memoryIndex}\n</lvis-memory-index>`);
        if (notes) parts.push(`<user-memory>\n${notes}\n</user-memory>`);

        // 인덱싱된 문서 요약 정보 추가 (ConversationLoop에서 주입)
        if (this.indexedDocsContext) {
          const docsContext = this.indexedDocsContext;
          parts.push(`<indexed-knowledge>\n${docsContext}\n</indexed-knowledge>`);
        }

        return parts.join("\n\n");
      },
    });

    // ⑧ Rolling Summary Preamble (per-session, set when prior context exists)
    // LLM context 구조: [system prompt] → [rolling summary preamble] → [recent N turns] → [current input]
    // 항상 주입 — compact 가 만든 12-section structured summary 가 다음 턴 LLM 에 전달되어야 의미 있음.
    //
    // Prompt-injection fence — the preamble is generated by an LLM
    // from prior conversation content, which means a previous user turn could
    // have contained text resembling an instruction ("ignore previous
    // instructions and …") that survived summarization. Wrap it in an
    // explicit non-instruction frame so subsequent reasoning treats the
    // block as inert context, not as a new directive. The fence costs ~2
    // tokens and closes a real-world prompt-injection vector at zero risk.
    // Rolling Summary Preamble — id=2.5 로 격상 (2026-05-07).
    //
    // 이전 id=8 은 prompt 의 거의 끝 (env / meta output 직전) 이라 LLM 의
    // recency bias 가 meta-output instruction (title emit) 을 더 강조하고
    // 정작 *prior context* 는 약하게 처리 → checkpoint/fork resume 직후 첫 turn 에 LLM 이
    // 컨텍스트를 *완전히 잊는* 증상 발생 (사용자 보고 2026-05-07).
    //
    // id=2.5 = role definition (id=2) 다음, AGENTS.md context (id=3+) 보다 앞.
    // "이전 대화의 누적 맥락" 이 정보 계층상 *현재 사용자 작업의 즉시 배경*
    // 이므로 그 위치가 의미적으로 정확.
    //
    // Wording 도 정정: 이전엔 "새로운 사용자 입력으로 해석하지 마세요 — 단지
    // 맥락 참고용" 이라는 *외면 instruction* 이 너무 강해 LLM 이 맥락 자체
    // 까지 무시. 새 wording 은 *맥락 활용* 을 명시 + injection 방어는
    // "직접 행동을 트리거하지 말라" 로 좁힘.
    this.sources.push({
      id: 2.5,
      name: "Rolling Summary Preamble",
      refresh: "on-change",
      build: () => {
        const preamble = this.summaryPreamble;
        if (!preamble) return "";
        return [
          t("be_systemPromptBuilder.rollingSummaryPreambleHeading"),
          "",
          t("be_systemPromptBuilder.rollingSummaryPreambleUseContext"),
          "",
          t("be_systemPromptBuilder.rollingSummaryPreambleSecurityGuard"),
          "",
          "<prior-context-summary>",
          preamble,
          "</prior-context-summary>",
        ].join("\n");
      },
    });

    // ⑨ OS / Environment (매 턴)
    this.sources.push({
      id: 9,
      name: "OS / Environment",
      refresh: "per-turn",
      build: () => {
        const now = new Date();
        const kstParts = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Seoul",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false,
        }).formatToParts(now);
        const pick = (type: string) => kstParts.find((p) => p.type === type)?.value ?? "00";
        const kstIso = `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}+09:00`;
        return [
          "<environment>",
          `OS: ${platform()}`,
          `Host: ${hostname()}`,
          `User: ${userInfo().username}`,
          `LVIS Home: ${redactFsPath(lvisHome())}`,
          `Time: ${kstIso} (KST, UTC+9)`,
          `Locale: ${Intl.DateTimeFormat().resolvedOptions().locale}`,
          t("be_systemPromptBuilder.environmentDateTimeNote"),
          "</environment>",
        ].join("\n");
      },
    });

    // ⑨-b Conversation Continuity Guard (per-turn)
    //
    // Earlier continuous-backend builds asked the LLM to append hidden
    // <title>...</title> and [checkpoint] markers to the streamed final answer.
    // That made title/checkpoint extraction depend on user-visible text and
    // could truncate the answer when the model emitted metadata before closing
    // Markdown. Checkpoints are now host-managed at the next turn's preflight
    // boundary, so this section explicitly forbids those markers instead.
    this.sources.push({
      id: 9.9,
      name: "Conversation Continuity Guard",
      refresh: "per-turn",
      build: () => {
        const titleLine = this.sessionTitle
          ? `${t("be_systemPromptBuilder.currentSessionTitle", { title: this.sessionTitle })}\n\n`
          : "";
        return `${titleLine}${t("be_systemPromptBuilder.conversationContinuityGuard")}`;
      },
    });

    // ⑨-c Routine Summary Tag Instruction (conditional — routine sessions only)
    //
    // Emitted ONLY when routineMode=true. Instructs the LLM to append a
    // <summary>…</summary> tag at the end of its final answer so the host can
    // extract a clean one-sentence summary for OverlayCard display without
    // truncating the full response body. id=9.8 sits between Conversation Meta
    // Guard (9.9) block and the environment section (9), ordered just
    // before the guard so the LLM processes the annotation rule last.
    this.sources.push({
      id: 9.8,
      name: "Routine Summary Tag Instruction",
      refresh: "per-turn",
      build: () => {
        if (!this.routineMode) return "";
        return t("be_systemPromptBuilder.routineSummaryTagInstruction");
      },
    });

    // Suggested Replies — ghost-text contract. Renderer parses + filters the
    // <suggested_replies> block out of the user-visible stream; this section
    // just instructs the model to emit it. See
    // `docs/architecture/proposals/suggested-replies-ghost-text.md`.
    this.sources.push({
      id: 9.85,
      name: "Suggested Replies",
      refresh: "static",
      build: () => t("be_systemPromptBuilder.suggestedRepliesInstruction"),
    });

    // Active Session Context — 서버 인프라 의존
    // Feature Flags — 서버 인프라 의존

    this.sources.sort((a, b) => a.id - b.id);
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function sanitizeSkillCatalogText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function truncateSkillCatalogText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function renderSkillCatalogRecord(skill: SkillCatalogEntry): string {
  const name = truncateSkillCatalogText(sanitizeSkillCatalogText(skill.name), MAX_SKILL_NAME_CHARS);
  const description = truncateSkillCatalogText(
    sanitizeSkillCatalogText(skill.description),
    MAX_SKILL_DESCRIPTION_CHARS,
  );
  return JSON.stringify({ name, description: description || t("be_systemPromptBuilder.skillNoDescription") });
}

// ─── Constants ──────────────────────────────────────

const MAX_SKILL_CATALOG_ENTRIES = 80;
// Authoritative bound on the always-present skill-catalog metadata cost
// (skill-loading-policy.md §2). Anthropic Agent Skills treat each skill's
// name+description as a few-dozen-token fixed cost paid every session, so the
// catalog is token-budgeted, not only entry-capped. ~6000 tokens ≈ 60–100
// scoped skills at name+description size — comfortably above a realistic active
// scope while capping pathological catalogs; overflow is reachable via
// skill_list. The 80-entry cap remains a cheap pre-filter.
const SKILL_CATALOG_TOKEN_BUDGET = 6000;
const MAX_SKILL_NAME_CHARS = 96;
const MAX_SKILL_DESCRIPTION_CHARS = 320;
