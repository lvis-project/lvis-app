import { createContext, useContext, type ReactNode, type RefObject } from "react";
import type React from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { EstimateBreakdown } from "../../../lib/cost-estimator.js";
import type { ModelPricing } from "../../../shared/pricing-data.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import type { Attachment } from "../types/attachments.js";

/**
 * Cross-cutting chat-view state bundle. Groups props by concern so ChatView
 * and its subtree can consume via `useChatContext()` instead of ~41 props.
 *
 * Action callbacks (onAsk / onEditSave / onFork / onToggleStar / onRetryEffort /
 * isEntryStarred) remain direct props on ChatView for explicit data flow.
 */
export interface ChatContextValue {
  // Chat state
  entries: ChatEntry[];
  streaming: boolean;
  editingEntryIdx: number | null;
  setEditingEntryIdx: (i: number | null) => void;
  editBusy: boolean;
  question: string;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  chatEndRef: RefObject<HTMLDivElement | null>;
  /**
   * Active chat session id. Lives in the chat context so descendants
   * (notably SessionTodoPanel) can scope their per-session reactive
   * subscriptions without a separate prop drill. Empty string before the
   * first session id resolves on app boot.
   */
  currentSessionId: string;

  // API state
  hasApiKey: boolean | null;
  onOpenSettings: (tab?: string) => void;

  // Search
  searchOpen: boolean;
  searchQuery: string;
  searchCase: boolean;
  searchMatches: number[];
  searchMatchSet: Set<number>;
  searchIdx: number;
  searchHighlight: string;
  searchChangeQuery: (q: string) => void;
  searchToggleCase: () => void;
  searchNext: () => void;
  searchPrev: () => void;
  searchCloseOverlay: () => void;
  searchToggleOverlay: () => void;

  // Context / usage
  contextOverflowPct: number;
  usedTokens: number;
  contextBudget: number;
  /** Issue #912 — ring 이 사용하는 *실질 한도*. tpmLimit < contextBudget
   *  인 모델 (현재 nano) 에선 tpmLimit, else contextBudget. ring 의 100%
   *  이 provider request 한도 인지와 일치하도록. */
  effectiveBudget: number;
  // Issue #900 #1 — per-request TPM hint. tpmLimit undefined for models
  // without a registered tpmDefault (most models) → UI hides the indicator.
  tpmLimit: number | undefined;
  tpmPct: number | undefined;
  isTpmOverflow: boolean;

  // Persona prompts
  rolePresets: RolePreset[];
  activePreset: RolePreset | null;
  activePresetId: string;
  setActivePresetId: (id: string) => void;

  // Composer attachments — single source of truth lives in textarea body
  // (markers like [Image #N], [File #N], [Pasted text #N +X lines]). The
  // attachment metadata store hangs off this state. Local Indexer inline-attach
  // was removed in favor of automatic context loading at conversation time.
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  attachmentNCounter: { current: number };

  // Thinking toggle
  enableThinkingChat: boolean;
  toggleThinking: (v: boolean) => Promise<void> | void;

  // Cost
  costEstimate: EstimateBreakdown;
  costBadgeClass: string;
  /**
   * Active model 의 pricing — `TokenCostBadge` 가 cost 모드 토글에 사용.
   * undefined (unknown vendor/model or zero-price placeholder) 이면 토글
   * 비활성. Context-window lookup 과 달리 비용 표시는 billable pricing 이
   * 확인된 모델에서만 켠다.
   */
  activePricing: ModelPricing | undefined;
  /**
   * Active vendor — `TokenCostBadge` 가 cache 가산 분기 (claude only) 결정에
   * 사용. `engine/llm/pricing.ts:computeCost` 와 동일한 vendor-aware 룰을
   * UI 에 일치시키기 위해 propagate.
   */
  activeVendor: LLMVendor;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatContextProvider({
  value,
  children,
}: {
  value: ChatContextValue;
  children: ReactNode;
}) {
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  const v = useContext(ChatContext);
  if (!v) throw new Error("useChatContext must be used within ChatContextProvider");
  return v;
}
