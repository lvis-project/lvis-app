import { createContext, useContext, type ReactNode, type RefObject } from "react";
import type React from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { EstimateBreakdown } from "../../../lib/cost-estimator.js";

type RoutineResult = {
  routineId: string;
  trigger: string;
  summary: string;
  generatedAt: string;
};

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
  setQuestion: (q: string) => void;
  chatEndRef: RefObject<HTMLDivElement | null>;

  // API state
  hasApiKey: boolean | null;
  onOpenSettings: () => void;

  // Routine result
  routineResult: RoutineResult | null;
  onDismissRoutineResult: () => void;
  onSnoozeRoutineResult: () => void;

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

  // Context / usage
  contextOverflowPct: number;
  usedTokens: number;
  contextBudget: number;
  contextPercent: number;
  contextColor: string;

  // Role presets
  rolePresets: RolePreset[];
  activePreset: RolePreset | null;
  activePresetId: string;
  setActivePresetId: (id: string) => void;

  // Attached docs / PageIndex
  attachedDocs: Array<{ id: string; name: string }>;
  setAttachedDocs: React.Dispatch<React.SetStateAction<Array<{ id: string; name: string }>>>;
  docPopoverOpen: boolean;
  setDocPopoverOpen: (v: boolean) => void;
  indexedDocs: Array<{ id: string; name: string }>;
  docsLoading: boolean;
  refreshIndexedDocs: () => void | Promise<void>;

  // Language lock
  langLock: "off" | "ko" | "en";
  setLangLock: React.Dispatch<React.SetStateAction<"off" | "ko" | "en">>;

  // Thinking toggle
  vendorSupportsThinking: boolean;
  enableThinkingChat: boolean;
  toggleThinking: (v: boolean) => Promise<void> | void;

  // Cost
  costEstimate: EstimateBreakdown;
  costBadgeClass: string;
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
