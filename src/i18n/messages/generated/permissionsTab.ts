// AUTO-GENERATED — i18n migration. Source: src/ui/renderer/tabs/PermissionsTab.tsx. Do not edit by hand.
export const en = {
  // Reviewer interactive options
  "permissionsTab.interactiveOffLabel": "Off",
  "permissionsTab.interactiveOffDescription": "Always shows a confirmation dialog before a tool runs. (Default, safest)",
  "permissionsTab.interactiveLowLabel": "Auto-approve low risk",
  "permissionsTab.interactiveLowDescription": "Actions judged as low risk are automatically allowed without confirmation. Medium and high risk still show a confirmation dialog.",

  // Reviewer mode options
  "permissionsTab.reviewerModeDisabledLabel": "Validation off (auto-pass)",
  "permissionsTab.reviewerModeDisabledDescription": "Disables the permission reviewer and applies only category default policies. Per-tool block/allow rules remain in effect.",
  "permissionsTab.reviewerModeRuleLabel": "Rule-based validation",
  "permissionsTab.reviewerModeRuleDescription": "Only low-risk actions pass through local rules; medium and high risk are queued for review.",
  "permissionsTab.reviewerModeLlmLabel": "LLM validation",
  "permissionsTab.reviewerModeLlmDescription": "After rule validation, an LLM can raise the risk level. It cannot lower it.",
  "permissionsTab.reviewerModeStrictLabel": "Strict (all pending)",
  "permissionsTab.reviewerModeStrictDescription": "All mutating actions from both automated (headless) runs and interactive chat are sent to the pending queue. The user must manually approve before execution.",

  // Reviewer fallback options
  "permissionsTab.fallbackDenyLabel": "Block",
  "permissionsTab.fallbackDenyDescription": "On LLM error or response parse failure, sends to the pending queue.",
  "permissionsTab.fallbackRuleLabel": "Use rule result",
  "permissionsTab.fallbackRuleDescription": "On LLM failure, applies the local rule result as-is.",

  // Error messages from helper functions
  "permissionsTab.errorInvalidKey": "Invalid approval key.",
  "permissionsTab.errorReviewerRewireFailed": "Failed to reconnect the permission reviewer runtime; restored previous settings.",
  "permissionsTab.errorReviewerRewireHint": "Check the provider API key, model name, and error-handling policy, then apply again.",
  "permissionsTab.errorReviewerRewireDetail": "Detail: {detail}",
  "permissionsTab.errorUserKeyboardRequired": "Permission reviewer settings can only be changed from an active user input.",
  "permissionsTab.errorReviewerFallbackContext": "Permission reviewer error",

  // Loading / general error
  "permissionsTab.loading": "Loading...",
  "permissionsTab.errorLoadFailed": "Failed to load data.",

  // Revoke approval messages
  "permissionsTab.confirmRevokePersistent": "[{toolName}] Cancel persistent approval?\n\nThis cannot be undone. The next tool call will require approval again.",
  "permissionsTab.errorRevokeFailed": "Revoke failed: {message}",
  "permissionsTab.successRevokeApproval": "[{toolName}] Approval has been revoked.",
  "permissionsTab.errorRevokeRefreshFailed": "[{toolName}] Approval revoked but list refresh failed: {message}",

  // Mode change messages
  "permissionsTab.errorModeChangeFailed": "Failed to change execution mode.",
  "permissionsTab.errorModeChangeError": "Error changing execution mode: {message}",

  // Policy messages
  "permissionsTab.errorPolicyManaged": "This policy is managed by the IT administrator. Users cannot change it.",
  "permissionsTab.errorPolicyChangeFailed": "Failed to change policy.",

  // Reviewer settings messages
  "permissionsTab.errorReviewerChangeError": "Error changing reviewer settings: {message}",

  // Rule messages
  "permissionsTab.errorRuleAddFailed": "Failed to add rule ({error})",
  "permissionsTab.errorRuleAddError": "Error adding rule: {message}",
  "permissionsTab.errorRuleRemoveFailed": "Failed to delete rule ({error})",
  "permissionsTab.errorRuleRemoveError": "Error deleting rule: {message}",

  // Directory messages
  "permissionsTab.warnDirectoryAckRequired": "You must confirm the directory warnings before saving.",
  "permissionsTab.errorDirectoryAddError": "Error adding directory: {message}",
  "permissionsTab.errorDirectoryRemoveError": "Error removing directory: {message}",

  // Page header
  "permissionsTab.pageTitle": "Permissions",
  "permissionsTab.pageDescription": "Configure tool permission policies, reviewer settings, and the directory allowlist.",

  // Banner
  "permissionsTab.closeBannerAriaLabel": "Close notification",

  // Hook quarantine notice
  "permissionsTab.hookQuarantineBadge": "Awaiting review {count}",
  "permissionsTab.hookQuarantineTitle": "There are quarantined hook files.",
  "permissionsTab.hookQuarantineInstructionBefore": "Run ",
  "permissionsTab.hookQuarantineInstructionAfter": " in the chat input, then review each file and accept or reject it.",

  // Refresh button
  "permissionsTab.refreshButton": "Refresh",

  // Current policy summary section
  "permissionsTab.currentPolicySummaryTitle": "Current Permission Policy",
  "permissionsTab.currentPolicySummaryDescription": "Select one of: Default, Ask All, Auto-validate, or Allow All, then adjust the reviewer settings in detail.",
  "permissionsTab.summaryPolicyPreset": "Policy preset",
  "permissionsTab.summaryReviewer": "Permission reviewer",
  "permissionsTab.summaryApprovalDialog": "Approval dialog",
  "permissionsTab.summaryExplicitRequired": "Explicit action required",
  "permissionsTab.summaryCloseDenies": "Close action denies",

  // Policy section
  "permissionsTab.policyTitle": "Permission Policy",
  "permissionsTab.policyDescription": "Default allows read tools; Ask All confirms even reads. Auto-validate validates both headless and interactive runs through the reviewer; Allow All auto-allows tools outside hard-block scope but requires separate approval for access outside allowed directories.",
  "permissionsTab.policyAriaLabel": "Select permission policy",

  // Reviewer section
  "permissionsTab.reviewerTitle": "Permission Reviewer",
  "permissionsTab.reviewerDescription": "Applies to both automated (headless) runs and interactive chat. Choose how to validate. LLM validation runs after local rules and cannot lower the risk level.",
  "permissionsTab.reviewerRenameNoticeText": "Permission reviewer settings apply to both automated (headless) runs and interactive chat. Adjusting the policy here once will be reflected equally in both contexts.",
  "permissionsTab.closeButton": "Close",
  "permissionsTab.reviewerAriaLabel": "Select permission reviewer",

  // LLM settings panel
  "permissionsTab.llmSettingsTitle": "LLM Validation Settings",
  "permissionsTab.llmSettingsDescription": "The provider and model follow the active LLM in Intelligence Settings.",
  "permissionsTab.llmVerificationLabel": "Validation LLM",
  "permissionsTab.llmVerificationDescription": "Current provider/model from Intelligence Settings",
  "permissionsTab.errorHandlingLabel": "Error handling",
  "permissionsTab.llmProviderManagedNote": "Provider, model, API key, baseUrl, and Vertex project/region changes are managed in Intelligence Settings.",

  // Auto-approve low risk
  "permissionsTab.autoApproveLowRiskLabel": "Auto-approve low risk",
  "permissionsTab.autoApproveLowRiskDescription": "Tool executions judged as low risk are automatically allowed without confirmation. Medium and high risk executions always show a confirmation dialog.",
  "permissionsTab.autoApproveLowRiskAriaLabel": "Auto-approve low risk setting",

  // Inline warning banners
  "permissionsTab.warnReviewerDisabledAutoApproveInactive": "⚠ The permission reviewer is off, so auto-approve low risk is not active. Enable the reviewer with \"Rule-based validation\" or \"LLM validation\".",
  "permissionsTab.warnAutoModeAutoApproveOff": "⚠ Auto-approve low risk is off in \"Auto-validate\" mode. To allow low-risk actions without confirmation, enable \"Auto-approve low risk\" above.",
  "permissionsTab.warnStrictLowContradiction": "⛔ \"Ask All\" mode confirms all actions, but \"Auto-approve low risk\" is on — settings conflict. To keep the confirm-all policy, set auto-approve low risk to \"Off\".",
  "permissionsTab.warnAllowModeReviewerIgnored": "⚠ \"Allow All\" mode auto-allows all actions, so the permission reviewer and auto-approve low risk settings have no effect.",

  // CLI mapping panel
  "permissionsTab.cliMappingTitle": "CLI Mapping (slash commands)",
  "permissionsTab.cliMappingDescription": "You can also change the same settings using slash commands in the chat input.",
  "permissionsTab.cliMappingProviderNote": "provider/model follows the active LLM in Intelligence Settings.",

  // Framework panel
  "permissionsTab.frameworkPanelTitle": "Permission Reviewer Framework / Prompt",
  "permissionsTab.frameworkVersion": "Version",
  "permissionsTab.frameworkOutputContract": "Output contract",
  "permissionsTab.frameworkRiskLevels": "Risk level criteria",
  "permissionsTab.frameworkComposition": "Judgment composition",
  "permissionsTab.frameworkInputFields": "LLM input fields",
  "permissionsTab.frameworkSystemPromptTitle": "System prompt (raw)",

  // Approval dialog section
  "permissionsTab.approvalDialogTitle": "Approval Dialog Behavior",
  "permissionsTab.approvalDialogDescription": "When checked, clicking outside the modal and pressing Escape are blocked in the approval dialog — you must explicitly decide using a button or approval shortcut.",
  "permissionsTab.approvalDialogCheckboxAriaLabel": "Require explicit approval or denial via button or shortcut in the approval dialog",
  "permissionsTab.policyEnabled": "Enabled",
  "permissionsTab.policyDisabled": "Disabled",
  "permissionsTab.adminManagedTitle": "Managed by IT administrator",
  "permissionsTab.adminPolicyWithPath": "This policy was deployed by the company IT administrator (path: {policyAdminPath}). Users cannot change it.",
  "permissionsTab.adminPolicyNoPath": "This policy is managed by the IT administrator. Users cannot change it.",

  // Rules section
  "permissionsTab.rulesTitle": "Tool Rules",
  "permissionsTab.rulesDescriptionBefore": "Set always-allow / always-deny for specific tool patterns (wildcard supported: ",
  "permissionsTab.rulesDescriptionAfter": ").",
  "permissionsTab.rulesEmpty": "No saved rules.",
  "permissionsTab.rulesColPattern": "Pattern",
  "permissionsTab.rulesColAction": "Action",
  "permissionsTab.rulesColSource": "Source",
  "permissionsTab.actionAllow": "Allow",
  "permissionsTab.actionDeny": "Deny",
  "permissionsTab.sourceAll": "All",
  "permissionsTab.patternInputPlaceholder": "Pattern (e.g. mcp_*, agent_spawn)",
  "permissionsTab.addButton": "Add",

  // Directories section
  "permissionsTab.directoriesTitle": "Allowed Directories",
  "permissionsTab.directoriesDescription": "User-approved paths outside the working directory that file tools can access.",
  "permissionsTab.directoriesEmpty": "No additional allowed directories.",
  "permissionsTab.directoriesColPath": "Path",
  "permissionsTab.directoryInputPlaceholder": "Path (e.g. ~/Documents/project)",
  "permissionsTab.directoryWarningTitle": "Warning confirmation required",
  "permissionsTab.directoryWarningConfirmButton": "Confirm warnings and add",
  "permissionsTab.cancelButton": "Cancel",

  // User approvals section
  "permissionsTab.approvalsTitle": "User Approval Records ({count})",
  "permissionsTab.approvalsDescription": "List of tool approvals recorded for this session or persistently.",
  "permissionsTab.approvalsEmpty": "No recorded approvals.",
  "permissionsTab.approvalsColTool": "Tool",
  "permissionsTab.approvalsColScope": "Scope",
  "permissionsTab.approvalsColRisk": "Risk",
  "permissionsTab.approvalsColApprovedAt": "Approved at",
  "permissionsTab.approvalsColReason": "Reason",
  "permissionsTab.approvalsColAction": "Action",
  "permissionsTab.scopePersistent": "Persistent",
  "permissionsTab.scopeSession": "Session",
  "permissionsTab.verdictHighFixed": " (HIGH fixed)",
  "permissionsTab.revokeButton": "Revoke",

  // Audit log section
  "permissionsTab.auditLogTitle": "Audit Log",
  "permissionsTab.auditLogDescription": "View recent permission audit records and chain verification status.",
  "permissionsTab.auditLogOpenButton": "Open",
  "permissionsTab.auditLogHelp": "Open the audit log panel to view permission events from the last 7 days.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "permissionsTab.interactiveOffLabel": "끔",
  "permissionsTab.interactiveOffDescription": "도구가 실행되기 전 항상 확인 창을 표시합니다. (기본값, 가장 안전)",
  "permissionsTab.interactiveLowLabel": "저위험 자동 허용",
  "permissionsTab.interactiveLowDescription": "저위험으로 판단된 작업은 확인 없이 자동으로 허용합니다. 중·고위험은 여전히 확인 창이 표시됩니다.",

  "permissionsTab.reviewerModeDisabledLabel": "검증 끔 (자동 통과)",
  "permissionsTab.reviewerModeDisabledDescription": "권한 리뷰어를 끄고 카테고리 기본 정책만 적용합니다. 도구별 차단/허용 규칙은 그대로 유지됩니다.",
  "permissionsTab.reviewerModeRuleLabel": "규칙 기반 검증",
  "permissionsTab.reviewerModeRuleDescription": "로컬 규칙으로 저위험 작업만 통과시키고 중·고위험은 대기시킵니다.",
  "permissionsTab.reviewerModeLlmLabel": "LLM 검증",
  "permissionsTab.reviewerModeLlmDescription": "규칙 검증 뒤 LLM이 위험도를 올릴 수 있습니다. 낮출 수는 없습니다.",
  "permissionsTab.reviewerModeStrictLabel": "엄격 (모두 보류)",
  "permissionsTab.reviewerModeStrictDescription": "자동(헤드리스) 실행과 대화형 채팅의 변경 작업을 모두 보류 대기열로 보냅니다. 사용자가 직접 승인해야 실행됩니다.",

  "permissionsTab.fallbackDenyLabel": "차단",
  "permissionsTab.fallbackDenyDescription": "LLM 오류나 응답 파싱 실패 시 보류 대기열로 보냅니다.",
  "permissionsTab.fallbackRuleLabel": "규칙 결과 사용",
  "permissionsTab.fallbackRuleDescription": "LLM 실패 시 로컬 규칙 결과를 그대로 적용합니다.",

  "permissionsTab.errorInvalidKey": "유효하지 않은 승인 키입니다.",
  "permissionsTab.errorReviewerRewireFailed": "권한 리뷰어 런타임 재연결에 실패해 이전 설정으로 복원했습니다.",
  "permissionsTab.errorReviewerRewireHint": "공급자 API 키, 모델 이름, 오류 처리 정책을 확인한 뒤 다시 적용하세요.",
  "permissionsTab.errorReviewerRewireDetail": "상세: {detail}",
  "permissionsTab.errorUserKeyboardRequired": "권한 리뷰어 설정 변경은 활성 사용자 입력에서만 실행할 수 있습니다.",
  "permissionsTab.errorReviewerFallbackContext": "권한 리뷰어 오류",

  "permissionsTab.loading": "로딩 중...",
  "permissionsTab.errorLoadFailed": "데이터를 불러오지 못했습니다.",

  "permissionsTab.confirmRevokePersistent": "[{toolName}] 지속 승인을 취소하시겠습니까?\n\n취소 후 복구할 수 없으며, 다음 도구 호출 시 다시 승인 요청됩니다.",
  "permissionsTab.errorRevokeFailed": "취소 실패: {message}",
  "permissionsTab.successRevokeApproval": "[{toolName}] 승인이 취소되었습니다.",
  "permissionsTab.errorRevokeRefreshFailed": "[{toolName}] 승인이 취소되었으나 목록 새로고침 실패: {message}",

  "permissionsTab.errorModeChangeFailed": "실행 모드 변경에 실패했습니다.",
  "permissionsTab.errorModeChangeError": "실행 모드 변경 중 오류: {message}",

  "permissionsTab.errorPolicyManaged": "이 정책은 IT 관리자가 설정했습니다. 사용자가 변경할 수 없습니다.",
  "permissionsTab.errorPolicyChangeFailed": "정책 변경에 실패했습니다.",

  "permissionsTab.errorReviewerChangeError": "리뷰어 설정 변경 중 오류: {message}",

  "permissionsTab.errorRuleAddFailed": "규칙 추가 실패 ({error})",
  "permissionsTab.errorRuleAddError": "규칙 추가 중 오류: {message}",
  "permissionsTab.errorRuleRemoveFailed": "규칙 삭제 실패 ({error})",
  "permissionsTab.errorRuleRemoveError": "규칙 삭제 중 오류: {message}",

  "permissionsTab.warnDirectoryAckRequired": "디렉터리 경고를 확인한 뒤 다시 승인해야 저장됩니다.",
  "permissionsTab.errorDirectoryAddError": "디렉터리 추가 중 오류: {message}",
  "permissionsTab.errorDirectoryRemoveError": "디렉터리 삭제 중 오류: {message}",

  "permissionsTab.pageTitle": "권한",
  "permissionsTab.pageDescription": "도구 권한 정책, 리뷰어, 디렉터리 화이트리스트를 설정합니다",

  "permissionsTab.closeBannerAriaLabel": "알림 닫기",

  "permissionsTab.hookQuarantineBadge": "검토 대기 {count}",
  "permissionsTab.hookQuarantineTitle": "격리된 hook 파일이 있습니다.",
  "permissionsTab.hookQuarantineInstructionBefore": "채팅 입력창에서 ",
  "permissionsTab.hookQuarantineInstructionAfter": " 를 실행해 파일을 확인한 뒤 accept 또는 reject 하세요.",

  "permissionsTab.refreshButton": "새로고침",

  "permissionsTab.currentPolicySummaryTitle": "현재 권한 정책",
  "permissionsTab.currentPolicySummaryDescription": "기본, 전체 물어보기, 자동 검증, 전체 허용 중 하나를 선택하고 세부 리뷰어 설정을 조정합니다.",
  "permissionsTab.summaryPolicyPreset": "정책 프리셋",
  "permissionsTab.summaryReviewer": "권한 리뷰어",
  "permissionsTab.summaryApprovalDialog": "승인 대화상자",
  "permissionsTab.summaryExplicitRequired": "명시 액션 필수",
  "permissionsTab.summaryCloseDenies": "닫기 동작은 거부 처리",

  "permissionsTab.policyTitle": "권한 정책",
  "permissionsTab.policyDescription": "기본은 읽기 도구를 허용하고, 전체 물어보기는 읽기까지 확인합니다. 자동 검증은 자동(헤드리스) 실행과 대화형 채팅 모두를 권한 리뷰어 설정으로 검증하고, 전체 허용은 하드 차단 범위 밖의 도구를 자동 허용하되 허용 디렉터리 밖 접근은 별도 승인합니다.",
  "permissionsTab.policyAriaLabel": "권한 정책 선택",

  "permissionsTab.reviewerTitle": "권한 리뷰어",
  "permissionsTab.reviewerDescription": "자동(헤드리스) 실행과 대화형 채팅 모두에 적용됩니다. 어떻게 검증할지 선택하세요. LLM 검증은 로컬 규칙 뒤에 실행되며 위험도를 낮출 수 없습니다.",
  "permissionsTab.reviewerRenameNoticeText": "권한 리뷰어 설정은 자동(헤드리스) 실행과 대화형 채팅 모두에 적용됩니다. 이 패널에서 정책을 한 번 조정하면 두 영역에 동일하게 반영됩니다.",
  "permissionsTab.closeButton": "닫기",
  "permissionsTab.reviewerAriaLabel": "권한 리뷰어 선택",

  "permissionsTab.llmSettingsTitle": "LLM 검증 설정",
  "permissionsTab.llmSettingsDescription": "공급자와 모델은 지능 설정의 활성 LLM을 그대로 따릅니다.",
  "permissionsTab.llmVerificationLabel": "검증 LLM",
  "permissionsTab.llmVerificationDescription": "지능 설정의 현재 공급자/모델",
  "permissionsTab.errorHandlingLabel": "오류 처리",
  "permissionsTab.llmProviderManagedNote": "공급자, 모델, API 키, baseUrl, Vertex 프로젝트/리전 변경은 지능 설정에서 관리합니다.",

  "permissionsTab.autoApproveLowRiskLabel": "저위험 자동 허용",
  "permissionsTab.autoApproveLowRiskDescription": "위험도가 낮다고 판단된 도구 실행은 확인 없이 자동으로 허용합니다. 중간·높은 위험도의 실행은 어떤 경우에도 확인 창이 표시됩니다.",
  "permissionsTab.autoApproveLowRiskAriaLabel": "저위험 자동 허용 설정",

  "permissionsTab.warnReviewerDisabledAutoApproveInactive": "⚠ 권한 리뷰어가 꺼져 있어 저위험 자동 허용이 동작하지 않습니다. 권한 리뷰어를 \"규칙 기반 검증\" 또는 \"LLM 검증\"으로 켜세요.",
  "permissionsTab.warnAutoModeAutoApproveOff": "⚠ \"자동 검증\" 모드에서 저위험 자동 허용이 꺼져 있습니다. 저위험 작업을 확인 없이 허용하려면 위에서 \"저위험 자동 허용\"을 켜세요.",
  "permissionsTab.warnStrictLowContradiction": "⛔ \"전체 물어보기\" 모드는 모든 작업을 확인하지만 \"저위험 자동 허용\"이 켜져 있어 설정이 충돌합니다. 모두 확인 정책을 유지하려면 저위험 자동 허용을 \"끔\"으로 변경하세요.",
  "permissionsTab.warnAllowModeReviewerIgnored": "⚠ \"전체 허용\" 모드는 모든 작업을 자동 허용하므로 권한 리뷰어와 저위험 자동 허용 설정이 적용되지 않습니다.",

  "permissionsTab.cliMappingTitle": "CLI 매핑 (슬래시 명령)",
  "permissionsTab.cliMappingDescription": "동일 설정을 채팅 입력창에서 슬래시 명령으로도 변경할 수 있습니다.",
  "permissionsTab.cliMappingProviderNote": "provider/model 은 지능 설정의 활성 LLM을 따릅니다.",

  "permissionsTab.frameworkPanelTitle": "권한 리뷰어 프레임워크 / 프롬프트",
  "permissionsTab.frameworkVersion": "버전",
  "permissionsTab.frameworkOutputContract": "출력 계약",
  "permissionsTab.frameworkRiskLevels": "위험도 기준",
  "permissionsTab.frameworkComposition": "판단 구성",
  "permissionsTab.frameworkInputFields": "LLM 입력 필드",
  "permissionsTab.frameworkSystemPromptTitle": "시스템 프롬프트 원문",

  "permissionsTab.approvalDialogTitle": "승인 대화상자 동작",
  "permissionsTab.approvalDialogDescription": "체크 시 승인 대화상자에서 모달 외부 클릭과 Escape 키가 차단되어 버튼 또는 승인 단축키로 명시적으로 결정해야 합니다.",
  "permissionsTab.approvalDialogCheckboxAriaLabel": "승인 대화상자에서 버튼 또는 단축키로 명시적 승인 또는 거부를 요구",
  "permissionsTab.policyEnabled": "활성화됨",
  "permissionsTab.policyDisabled": "비활성화됨",
  "permissionsTab.adminManagedTitle": "IT 관리자 설정",
  "permissionsTab.adminPolicyWithPath": "이 정책은 회사 IT 관리자가 배포했습니다 (경로: {policyAdminPath}). 사용자가 변경할 수 없습니다.",
  "permissionsTab.adminPolicyNoPath": "이 정책은 IT 관리자가 설정했습니다. 사용자가 변경할 수 없습니다.",

  "permissionsTab.rulesTitle": "도구 규칙",
  "permissionsTab.rulesDescriptionBefore": "특정 도구 패턴에 대해 항상 허용 / 항상 거부를 설정합니다 (와일드카드 지원: ",
  "permissionsTab.rulesDescriptionAfter": ").",
  "permissionsTab.rulesEmpty": "저장된 규칙이 없습니다.",
  "permissionsTab.rulesColPattern": "패턴",
  "permissionsTab.rulesColAction": "동작",
  "permissionsTab.rulesColSource": "소스",
  "permissionsTab.actionAllow": "허용",
  "permissionsTab.actionDeny": "거부",
  "permissionsTab.sourceAll": "전체",
  "permissionsTab.patternInputPlaceholder": "패턴 (예: mcp_*, agent_spawn)",
  "permissionsTab.addButton": "추가",

  "permissionsTab.directoriesTitle": "허용 디렉터리",
  "permissionsTab.directoriesDescription": "작업 디렉터리 밖에서 파일 도구가 접근할 수 있는 사용자 승인 경로입니다.",
  "permissionsTab.directoriesEmpty": "추가 허용 디렉터리가 없습니다.",
  "permissionsTab.directoriesColPath": "경로",
  "permissionsTab.directoryInputPlaceholder": "경로 (예: ~/Documents/project)",
  "permissionsTab.directoryWarningTitle": "경고 확인 필요",
  "permissionsTab.directoryWarningConfirmButton": "경고 확인 후 추가",
  "permissionsTab.cancelButton": "취소",

  "permissionsTab.approvalsTitle": "사용자 승인 기록 ({count})",
  "permissionsTab.approvalsDescription": "세션 또는 지속적으로 기록된 도구 승인 목록입니다.",
  "permissionsTab.approvalsEmpty": "기록된 승인이 없습니다.",
  "permissionsTab.approvalsColTool": "도구",
  "permissionsTab.approvalsColScope": "범위",
  "permissionsTab.approvalsColRisk": "위험도",
  "permissionsTab.approvalsColApprovedAt": "승인 일시",
  "permissionsTab.approvalsColReason": "사유",
  "permissionsTab.approvalsColAction": "액션",
  "permissionsTab.scopePersistent": "지속",
  "permissionsTab.scopeSession": "세션",
  "permissionsTab.verdictHighFixed": " (HIGH 고정)",
  "permissionsTab.revokeButton": "취소",

  "permissionsTab.auditLogTitle": "감사 로그",
  "permissionsTab.auditLogDescription": "최근 권한 감사 기록과 체인 검증 상태를 확인합니다.",
  "permissionsTab.auditLogOpenButton": "열기",
  "permissionsTab.auditLogHelp": "감사 로그 패널을 열어 최근 7일간의 권한 이벤트를 확인하세요.",
};
