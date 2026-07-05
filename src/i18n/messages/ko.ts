/**
 * Korean message catalog. Mirrors every key in {@link ./en}; the
 * `Record<MessageKey, string>` annotation makes a missing key a build error so
 * translations stay complete as new keys are added.
 */
import type { SeedMessageKey } from "./en.js";

export const ko: Record<SeedMessageKey, string> = {
  // ── Common / shared ───────────────────────────────────────────────
  "common.cancel": "취소",
  "common.allow": "허용",
  "common.confirm": "확인",
  "common.ok": "확인",
  "common.save": "저장",
  "common.close": "닫기",
  "common.delete": "삭제",
  "common.remove": "제거",
  "common.retry": "다시 시도",
  "common.loading": "불러오는 중…",
  "common.error": "오류",
  "common.thinking": "생각 중...",

  // ── Settings → Appearance → Language ──────────────────────────────
  "settings.appearance.language.title": "언어",
  "settings.appearance.language.description":
    "앱 전체에서 사용할 언어를 선택하세요. 변경 사항은 즉시 적용됩니다.",
  "settings.appearance.language.saved": "언어가 변경되었습니다.",

  // ── Main-process dialogs / menus / notifications ──────────────────
  "mainDialog.restart": "재시작",
  "mainDialog.updateApplyTitle": "업데이트 적용",
  "mainDialog.updateRestartMessage": "LVIS v{version} 으로 재시작합니다.",
  "mainDialog.updateRestartDetail": "진행 중인 작업이 종료됩니다. 계속하시겠습니까?",
  "mainDialog.attachTitle": "첨부 파일 선택",
  "mainDialog.installLocalPluginTitle": "로컬 플러그인 설치 (개발자)",
  "mainDialog.installLocalPluginMessage": "plugin.json이 포함된 빌드 폴더를 선택하세요",
  "mainDialog.unauthorizedFrame": "권한이 없는 프레임입니다.",
  "mainDialog.noPersonasAvailable": "사용 가능한 persona 없음",
  "mainDialog.exportConversationTitle": "대화 내보내기",
  "mainDialog.importConversationTitle": "대화 가져오기",
};
