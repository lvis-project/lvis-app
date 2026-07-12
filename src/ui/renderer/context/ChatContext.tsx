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



  activePricing: ModelPricing | undefined;



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

/**
 * Non-throwing read, for components that also mount OUTSIDE the chat subtree
 * (McpAppView: transcript card, preview rail, detached window, isolated test
 * harness). `null` means "no chat session owns this surface" — a caller must treat
 * that as an absent binding, never as the active session.
 */
export function useOptionalChatContext(): ChatContextValue | null {
  return useContext(ChatContext);
}
