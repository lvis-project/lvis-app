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

  // ── E4 — 시작 / 전역 단축키 설정 탭 ────────────────────────────────
  "settingsContent.tabStartup": "시작",
  "startupTab.title": "시작 및 단축키",
  "startupTab.description":
    "창을 표시/숨기는 전역 단축키를 설정하고, 로그인 시 LVIS 자동 실행 여부를 선택하세요.",
  "startupTab.shortcutSectionTitle": "전역 단축키",
  "startupTab.shortcutSectionDesc":
    "어디서든 LVIS 창을 표시하거나 숨기는 시스템 전역 키 조합입니다.",
  "startupTab.shortcutEnabledLabel": "전역 단축키 사용",
  "startupTab.shortcutEnabledHint": "운영체제에 단축키를 등록합니다.",
  "startupTab.shortcutAcceleratorLabel": "창 표시/숨기기 단축키",
  "startupTab.shortcutRecord": "녹화",
  "startupTab.shortcutClear": "지우기",
  "startupTab.shortcutCapturing": "키 조합을 누르세요…",
  "startupTab.shortcutUnset": "설정 안 됨",
  "startupTab.shortcutEnabledNoAccelerator":
    "단축키가 켜져 있지만 키 조합이 설정되지 않았습니다. 조합을 녹화해 활성화하세요.",
  "startupTab.shortcutRegisterFailedTitle": "단축키 등록 실패",
  "startupTab.shortcutRegisterFailedBody":
    "{accelerator} 은(는) 다른 앱이 사용 중입니다. 다른 조합을 선택하세요.",
  "startupTab.launchSectionTitle": "시작 시 자동 실행",
  "startupTab.launchSectionDesc":
    "컴퓨터에 로그인할 때 LVIS 를 자동으로 시작할지 설정합니다.",
  "startupTab.launchAtStartupLabel": "로그인 시 LVIS 실행",
  "startupTab.launchAtStartupHint": "로그인 후 LVIS 를 자동으로 시작합니다. (설치된 앱에서만 적용)",
  "startupTab.launchMinimizedLabel": "트레이에 숨겨서 시작",
  "startupTab.launchMinimizedHint": "자동 실행 시 창을 열지 않고 트레이에 최소화된 상태로 시작합니다.",
  "startupTab.launchRegisterFailedTitle": "시작 시 자동 실행을 적용하지 못했습니다",
  "startupTab.launchRegisterFailedBody":
    "이 시스템에서 로그인 시 자동 실행을 등록하지 못했습니다. 설정에서 다시 시도하세요.",
};
