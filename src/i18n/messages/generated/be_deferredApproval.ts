// The question the host asks when a tool call is deferred for approval.
//
// The prompt names the tool and, when the entry recorded one, the directory an
// approval would open — the host-resolved path, never text the user typed — so
// the choice is legible before it is made. `src/ipc/domains/permissions.ts`
// builds the card and maps the answer onto the resolve path.
export const en = {
  "be_deferredApproval.question": "Allow '{toolName}' to run?",
  "be_deferredApproval.questionWithGrant":
    "Allow '{toolName}' to reach files under {path} for the rest of this conversation?",
  "be_deferredApproval.choiceApprove": "Allow",
  "be_deferredApproval.choiceReject": "Deny",
  "be_deferredApproval.choiceKeepDeferred": "Decide later",
  "be_deferredApproval.summaryHint": "Permission",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_deferredApproval.question": "'{toolName}' 실행을 허용할까요?",
  "be_deferredApproval.questionWithGrant":
    "'{toolName}' 이 이 대화가 끝날 때까지 {path} 하위 파일에 접근하도록 허용할까요?",
  "be_deferredApproval.choiceApprove": "허용",
  "be_deferredApproval.choiceReject": "거절",
  "be_deferredApproval.choiceKeepDeferred": "나중에 결정",
  "be_deferredApproval.summaryHint": "권한",
};
