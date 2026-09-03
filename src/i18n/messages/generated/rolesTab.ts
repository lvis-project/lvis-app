// AUTO-GENERATED — i18n migration. Source: src/ui/renderer/tabs/RolesTab.tsx. Do not edit by hand.
export const en = {
  // Section tab labels
  "rolesTab.sectionAgents": "AGENTS.md",
  "rolesTab.sectionMemory": "MEMORY.md",
  "rolesTab.sectionPreferences": "User Preferences",
  "rolesTab.sectionRoles": "Role Prompts",
  "rolesTab.sectionPreview": "SSOT",

  // Page header
  "rolesTab.pageTitle": "Roles",
  "rolesTab.pageDescription": "Manage Persona prompts in ~/.lvis/prompts",

  // Section header
  "rolesTab.sectionSourceTitle": "Role Sources",

  // Loading indicator
  "rolesTab.loadingBadge": "Loading",

  // Agents section
  "rolesTab.savingLabel": "Saving...",
  "rolesTab.saveAgentsButton": "Save AGENTS.md",

  // Agents section — packaged updates and the keep-latest split
  "rolesTab.keepLatestLabel": "Always keep the latest",
  "rolesTab.keepLatestHint":
    "AGENTS.md stays on the shipped version, your own content moves to agents.custom.md, and every turn reads it after AGENTS.md.",
  "rolesTab.packagedBadge": "Shipped",
  "rolesTab.upgradeMarkersTitle": "{count} update(s) waiting",
  "rolesTab.markerReadOnlyNote": "Review this file directly.",
  "rolesTab.viewDiffButton": "View difference",
  "rolesTab.applyPackagedButton": "Apply shipped version",
  "rolesTab.keepMineButton": "Keep mine",
  "rolesTab.mergeButton": "Refresh",
  "rolesTab.mergingLabel": "Merging...",
  "rolesTab.mergedTitle": "Merged result — review before applying",
  "rolesTab.applyMergedButton": "Apply",
  "rolesTab.discardMergedButton": "Discard",
  "rolesTab.statusPackagedApplied": "Applied the shipped version.",
  "rolesTab.statusPackagedAppliedWithCustom":
    "Applied the shipped version. Your own content moved to agents.custom.md.",
  "rolesTab.statusKeptMine": "Kept your version and dismissed the update.",
  "rolesTab.statusMerged": "Merge ready. Review it before applying.",
  "rolesTab.statusMergedApplied": "Applied the merged document.",
  "rolesTab.statusMergedDiscarded": "Discarded the merged document.",

  // Memory section
  "rolesTab.quickMemoryPlaceholder": "Urgent memory (approx. 500 characters)",
  "rolesTab.referenceLinkPlaceholder": "Reference links",
  "rolesTab.reloadButton": "Reload",
  "rolesTab.saveMemoryButton": "Save MEMORY.md",
  "rolesTab.saveToSectionButton": "Save to section",
  "rolesTab.detailMemoryTitlePlaceholder": "Detailed memory title",
  "rolesTab.detailMemoryPlaceholder": "Detailed memory",
  "rolesTab.saveDetailMemoryButton": "Save detailed memory",
  "rolesTab.consolidateLongTermMemoryButton": "Consolidate long-term memory",
  "rolesTab.consolidatingLongTermMemoryLabel": "Consolidating...",

  // Preferences section
  "rolesTab.refreshingLabel": "Refreshing...",
  "rolesTab.refreshWithLlmButton": "Refresh with LLM",
  "rolesTab.saveUserPrefsButton": "Save user-preferences.md",

  // Roles section
  "rolesTab.defaultBadge": "Default",
  "rolesTab.noRolePrompt": "No role prompt",
  "rolesTab.editButton": "Edit",
  "rolesTab.deleteButton": "Delete",
  "rolesTab.editPromptHeading": "Edit Prompt",
  "rolesTab.newRolePromptHeading": "New Role Prompt",
  "rolesTab.namePlaceholder": "Name",
  "rolesTab.systemPromptPlaceholder": "Role instructions to inject into the system prompt for this turn",
  "rolesTab.cancelButton": "Cancel",
  "rolesTab.updateButton": "Update",
  "rolesTab.addButton": "Add",

  // Status messages
  "rolesTab.statusRoleSaved": "Role prompt saved.",
  "rolesTab.statusRoleDeleted": "Role prompt deleted.",
  "rolesTab.statusAgentsSaved": "AGENTS.md saved.",
  "rolesTab.statusUserPrefsSaved": "user-preferences.md saved.",
  "rolesTab.statusUserPrefsRefreshed": "LLM has refreshed user-preferences.md.",
  "rolesTab.statusMemoryReloaded": "MEMORY.md reloaded.",
  "rolesTab.statusMemorySaved": "MEMORY.md saved.",
  "rolesTab.statusQuickMemorySaved": "Urgent memory saved to MEMORY.md sections.",
  "rolesTab.statusDetailMemorySaved": "Detailed memory saved to memories/.",
  "rolesTab.statusLongTermMemoryConsolidated": "Long-term memory consolidation completed.",
  "rolesTab.statusLongTermMemoryUpToDate": "Long-term memory is already up to date.",
  "rolesTab.statusLongTermMemoryEmpty": "No active long-term memories need consolidation.",

  // Error messages
  "rolesTab.errorMemoryConflict": "MEMORY.md was modified by another operation and has been reloaded. Please review and save again.",
  "rolesTab.errorMemorySectionSaveFailed": "Failed to save MEMORY.md sections",
  "rolesTab.errorLongTermMemoryConsolidationUnavailable": "Long-term memory consolidation is unavailable.",
  "rolesTab.errorLongTermMemoryConsolidationFailed": "Long-term memory consolidation failed.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  // Section tab labels
  "rolesTab.sectionAgents": "AGENTS.md",
  "rolesTab.sectionMemory": "MEMORY.md",
  "rolesTab.sectionPreferences": "User Preferences",
  "rolesTab.sectionRoles": "역할 프롬프트",
  "rolesTab.sectionPreview": "SSOT",

  // Page header
  "rolesTab.pageTitle": "역할",
  "rolesTab.pageDescription": "~/.lvis/prompts의 Persona 프롬프트를 관리합니다",

  // Section header
  "rolesTab.sectionSourceTitle": "역할 소스",

  // Loading indicator
  "rolesTab.loadingBadge": "읽는 중",

  // Agents section
  "rolesTab.savingLabel": "저장 중...",
  "rolesTab.saveAgentsButton": "AGENTS.md 저장",

  // Agents section — packaged updates and the keep-latest split
  "rolesTab.keepLatestLabel": "항상 최신 내용 유지",
  "rolesTab.keepLatestHint":
    "AGENTS.md 는 배포본을 유지하고, 사용자가 쓴 내용은 agents.custom.md 로 옮겨집니다. 매 턴 AGENTS.md 다음에 이 파일을 읽습니다.",
  "rolesTab.packagedBadge": "배포본",
  "rolesTab.upgradeMarkersTitle": "업그레이드 안내 {count}건",
  "rolesTab.markerReadOnlyNote": "이 파일은 직접 열어 확인하세요.",
  "rolesTab.viewDiffButton": "차이 보기",
  "rolesTab.applyPackagedButton": "배포본 적용",
  "rolesTab.keepMineButton": "내 것 유지",
  "rolesTab.mergeButton": "갱신하기",
  "rolesTab.mergingLabel": "병합 중...",
  "rolesTab.mergedTitle": "병합 결과 — 적용 전에 확인하세요",
  "rolesTab.applyMergedButton": "적용",
  "rolesTab.discardMergedButton": "버리기",
  "rolesTab.statusPackagedApplied": "배포본을 적용했습니다.",
  "rolesTab.statusPackagedAppliedWithCustom":
    "배포본을 적용했습니다. 사용자가 쓴 내용은 agents.custom.md 로 옮겼습니다.",
  "rolesTab.statusKeptMine": "기존 내용을 유지하고 안내를 지웠습니다.",
  "rolesTab.statusMerged": "병합 결과가 준비됐습니다. 확인 후 적용하세요.",
  "rolesTab.statusMergedApplied": "병합한 문서를 적용했습니다.",
  "rolesTab.statusMergedDiscarded": "병합한 문서를 버렸습니다.",

  // Memory section
  "rolesTab.quickMemoryPlaceholder": "긴급 기억 (500자 내외)",
  "rolesTab.referenceLinkPlaceholder": "레퍼런스 링크",
  "rolesTab.reloadButton": "다시 읽기",
  "rolesTab.saveMemoryButton": "MEMORY.md 저장",
  "rolesTab.saveToSectionButton": "섹션에 저장",
  "rolesTab.detailMemoryTitlePlaceholder": "상세 기억 제목",
  "rolesTab.detailMemoryPlaceholder": "상세 기억",
  "rolesTab.saveDetailMemoryButton": "상세 기억 저장",
  "rolesTab.consolidateLongTermMemoryButton": "장기 기억 통합",
  "rolesTab.consolidatingLongTermMemoryLabel": "통합 중...",

  // Preferences section
  "rolesTab.refreshingLabel": "갱신 중...",
  "rolesTab.refreshWithLlmButton": "LLM으로 갱신",
  "rolesTab.saveUserPrefsButton": "user-preferences.md 저장",

  // Roles section
  "rolesTab.defaultBadge": "기본",
  "rolesTab.noRolePrompt": "역할 프롬프트 없음",
  "rolesTab.editButton": "편집",
  "rolesTab.deleteButton": "삭제",
  "rolesTab.editPromptHeading": "프롬프트 편집",
  "rolesTab.newRolePromptHeading": "새 역할 프롬프트",
  "rolesTab.namePlaceholder": "이름",
  "rolesTab.systemPromptPlaceholder": "해당 턴의 시스템 프롬프트에 주입할 역할 지시",
  "rolesTab.cancelButton": "취소",
  "rolesTab.updateButton": "업데이트",
  "rolesTab.addButton": "추가",

  // Status messages
  "rolesTab.statusRoleSaved": "역할 프롬프트를 저장했습니다.",
  "rolesTab.statusRoleDeleted": "역할 프롬프트를 삭제했습니다.",
  "rolesTab.statusAgentsSaved": "AGENTS.md를 저장했습니다.",
  "rolesTab.statusUserPrefsSaved": "user-preferences.md를 저장했습니다.",
  "rolesTab.statusUserPrefsRefreshed": "LLM이 user-preferences.md를 갱신했습니다.",
  "rolesTab.statusMemoryReloaded": "MEMORY.md를 다시 읽었습니다.",
  "rolesTab.statusMemorySaved": "MEMORY.md를 저장했습니다.",
  "rolesTab.statusQuickMemorySaved": "긴급 기억을 MEMORY.md 섹션에 저장했습니다.",
  "rolesTab.statusDetailMemorySaved": "상세 기억을 memories/에 저장했습니다.",
  "rolesTab.statusLongTermMemoryConsolidated": "장기 기억 통합을 완료했습니다.",
  "rolesTab.statusLongTermMemoryUpToDate": "장기 기억이 이미 최신 상태입니다.",
  "rolesTab.statusLongTermMemoryEmpty": "통합할 활성 장기 기억이 없습니다.",

  // Error messages
  "rolesTab.errorMemoryConflict": "MEMORY.md가 다른 작업으로 변경되어 다시 읽었습니다. 확인 후 다시 저장하세요.",
  "rolesTab.errorMemorySectionSaveFailed": "MEMORY.md 섹션 저장 실패",
  "rolesTab.errorLongTermMemoryConsolidationUnavailable": "장기 기억 통합 서비스를 사용할 수 없습니다.",
  "rolesTab.errorLongTermMemoryConsolidationFailed": "장기 기억 통합에 실패했습니다.",
};
