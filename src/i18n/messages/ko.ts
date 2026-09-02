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
  "mainDialog.pluginPickFolderTitle": "{plugin}에서 사용할 폴더 선택",
  "mainDialog.installLocalPluginTitle": "로컬 플러그인 설치 (개발자)",
  "mainDialog.installLocalPluginMessage": "plugin.json이 포함된 빌드 폴더를 선택하세요",
  "mainDialog.unauthorizedFrame": "권한이 없는 프레임입니다.",
  "mainDialog.pluginDisableNotPermitted": "이 플러그인은 조직에서 관리하므로 비활성화할 수 없습니다.",
  "mainDialog.exportConversationTitle": "대화 내보내기",
  "mainDialog.deleteConversationMessage": "이 대화를 삭제할까요?",
  "mainDialog.deleteConversationDetail": "대화 기록과 체크포인트가 디스크에서 제거됩니다. 되돌릴 수 없습니다.",
  "mainDialog.deleteConversationConfirm": "삭제",
  "mainDialog.cancelButton": "취소",
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
  "startupTab.renderingSectionTitle":
    "화면 렌더링",
  "startupTab.renderingSectionDesc":
    "LVIS 가 화면을 그릴 때 그래픽 카드를 사용할지 설정합니다.",
  "startupTab.hardwareAccelerationLabel":
    "하드웨어 가속 사용",
  "startupTab.hardwareAccelerationHelp":
    "다음 실행부터 적용됩니다. 창이 검게 나오거나 깜빡이거나 화면을 그리다 앱이 죽는다면 끄세요 — 일부 사내 관리 PC 와 가상 데스크톱의 그래픽 드라이버는 이 기능을 감당하지 못합니다. 그래서 Windows 와 Linux 에서는 기본값이 꺼짐입니다.",
  "startupTab.hardwareAccelerationEnvForced":
    "환경 변수 {envVar} 가 여기에 저장된 값과 관계없이 이 항목을 켜고 있습니다.",
  "startupTab.corpCaSectionTitle":
    "회사 네트워크 인증서",
  "startupTab.corpCaSectionDesc":
    "회사에서 발급한 루트 인증서로 TLS 트래픽을 검사하는 네트워크를 위한 설정입니다.",
  "startupTab.corpCaEnabledLabel":
    "회사 루트 인증서 신뢰",
  "startupTab.corpCaEnabledHelp":
    "다음 실행부터 적용됩니다. 웹 페이지는 운영체제가 신뢰하는 인증서를 그대로 따르지만, 모델 호출·마켓플레이스 요청·업데이트 확인은 별도로 검증하기 때문에 따르지 않습니다. TLS 트래픽을 검사하는 네트워크에서는 페이지는 잘 열리는데 이쪽만 인증서 오류로 실패하며, 이 설정이 그 문제를 해결합니다. 잘 모르겠으면 켜 두세요 — 해당 인증서가 없는 PC 에서는 아무것도 찾지 못하고 아무것도 바뀌지 않습니다.",
  "startupTab.corpCaEnabledEnvForced":
    "환경 변수 {envVar} 가 여기에 저장된 값과 관계없이 이 항목을 끄고 있습니다.",
  "startupTab.corpCaCommonNameLabel":
    "인증서 이름",
  "startupTab.corpCaCommonNameHelp":
    "시스템 인증서 저장소에 등록된 회사 루트 인증서의 일반 이름(CN)입니다. 아래 기본값은 예시일 뿐이니, 인증서 오류가 계속되면 사내 IT 담당자에게 실제 이름을 확인하세요. 이름의 일부만 적어도 찾습니다.",
  "startupTab.corpCaCommonNameEnvForced":
    "환경 변수 {envVar} 가 여기에 저장된 값 대신 이 이름을 지정하고 있습니다.",
  "startupTab.corpCaDebugLabel":
    "인증서 조회 과정 기록",
  "startupTab.corpCaDebugHelp":
    "무엇을 찾았고 무엇이 나왔는지 애플리케이션 로그에 남깁니다. 인증서 문제를 진단할 때만 켜세요.",
  "startupTab.corpCaDebugEnvForced":
    "환경 변수 {envVar} 가 여기에 저장된 값과 관계없이 이 항목을 켜고 있습니다.",
  "startupTab.launchSectionTitle": "시작 시 자동 실행",
  "startupTab.launchSectionDesc":
    "컴퓨터에 로그인할 때 LVIS 를 자동으로 시작할지 설정합니다.",
  "startupTab.launchAtStartupLabel": "로그인 시 LVIS 실행",
  "startupTab.launchAtStartupHint": "로그인 후 LVIS 를 자동으로 시작합니다. (설치된 앱에서만 적용)",
  "startupTab.launchMinimizedLabel": "트레이에 숨겨서 시작",
  "startupTab.launchMinimizedHint": "자동 실행 시 창을 열지 않고 트레이에 최소화된 상태로 시작합니다.",
  "startupTab.launchRegisterFailedTitle": "시작 시 자동 실행을 적용하지 못했습니다",
  "startupTab.shutdownTimeoutLabel":
    "종료 시 정리에 허용할 시간",
  "startupTab.shutdownTimeoutHelp":
    "종료하면 LVIS 는 루틴, 플러그인, 백그라운드 프로세스를 정지하고 창 배치를 저장한 뒤 닫힙니다. 이 시간 안에 끝나지 않으면 그대로 닫히며, 아직 기록 중이던 내용은 버려집니다. 종료가 오래 걸리는 플러그인이 있으면 늘리고, 종료가 느리게 느껴지면 줄이세요.",
  "startupTab.shutdownTimeoutEnvForced":
    "지금은 환경 변수 {envVar} 가 이 값을 지정하고 있어, 여기에 저장된 값 대신 사용됩니다.",
  "startupTab.shutdownTimeoutSeconds": "{seconds}초",
  "startupTab.shutdownTimeoutSecondsDefault": "{seconds}초 (기본)",
  "startupTab.launchRegisterFailedBody":
    "이 시스템에서 로그인 시 자동 실행을 등록하지 못했습니다. 설정에서 다시 시도하세요.",
};
