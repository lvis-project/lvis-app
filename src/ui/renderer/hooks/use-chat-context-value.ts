import { useMemo } from "react";
import type { ChatContextValue } from "../context/ChatContext.js";

/**
 * Builds the memoized ChatContextValue from its constituent pieces. Extracted
 * from App.tsx so the composition root isn't dominated by a 33-field bundle
 * with a duplicate dependency list.
 */
export function useChatContextValue(parts: ChatContextValue): ChatContextValue {
  // Pull each field into a local so the dep list is a flat spread of the
  // structural shape and stays in lockstep with ChatContextValue.
  const {
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, hasApiKey, onOpenSettings,
    routineResult, onDismissRoutineResult, onSnoozeRoutineResult,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet,
    searchIdx, searchHighlight, searchChangeQuery, searchToggleCase,
    searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs, langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
  } = parts;

  return useMemo<ChatContextValue>(() => ({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, hasApiKey, onOpenSettings,
    routineResult, onDismissRoutineResult, onSnoozeRoutineResult,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet,
    searchIdx, searchHighlight, searchChangeQuery, searchToggleCase,
    searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs, langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
  }), [
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, hasApiKey, onOpenSettings,
    routineResult, onDismissRoutineResult, onSnoozeRoutineResult,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet,
    searchIdx, searchHighlight, searchChangeQuery, searchToggleCase,
    searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs, langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking,
    costEstimate, costBadgeClass,
  ]);
}
