import type { Locale } from "./i18n";

export type OS = "mac" | "windows" | "linux";

export interface DownloadStep {
  label: string;
  command?: string;
}

export interface DownloadTarget {
  os: OS;
  osLabel: string;
  title: string;
  format: string;
  href: string;
  setupNote: string;
  steps: DownloadStep[];
  extraNote?: string;
}

/**
 * Download buttons always point at the latest GitHub Release assets.
 * Flip a flag to false to render a "준비 중" state if an asset is
 * temporarily missing from the latest release (manual safety valve —
 * we intentionally do no runtime HEAD probing on a static site).
 */
export const KNOWN_AVAILABLE: Record<OS, boolean> = {
  mac: true,
  windows: true,
  linux: true,
};

export const ALL_RELEASES_URL =
  "https://github.com/lvis-project/lvis-app/releases";

/** Per-OS download targets. `command`, `os`, `osLabel`, `title`, `format`, and
 *  `href` are locale-neutral; only the human-readable notes/step labels vary. */
export function getDownloads(locale: Locale): DownloadTarget[] {
  const en = locale === "en";
  return [
    {
      os: "mac",
      osLabel: "macOS",
      title: "Apple Silicon",
      format: "DMG · arm64",
      href: "/download/mac",
      setupNote: en
        ? "The app isn't signed with an Apple Developer certificate, so Gatekeeper blocks it. Open the DMG, move LVIS.app to /Applications, then run the command below in Terminal."
        : "Apple 개발자 서명이 없어 Gatekeeper가 실행을 차단합니다. DMG를 열어 LVIS.app을 /Applications로 옮긴 뒤, 터미널에서 아래를 실행하세요.",
      steps: [
        {
          label: en
            ? "Remove the quarantine attribute (clears the Gatekeeper block)"
            : "격리 속성 제거 (Gatekeeper 차단 해제)",
          command: 'sudo xattr -dr com.apple.quarantine "/Applications/LVIS.app"',
        },
        {
          label: en ? "Launch" : "실행",
          command: 'open "/Applications/LVIS.app"',
        },
      ],
    },
    {
      os: "windows",
      osLabel: "Windows",
      title: "Windows 10+",
      format: "Installer · x64",
      href: "/download/windows",
      setupNote: en
        ? "Because the app is unsigned, Microsoft Defender SmartScreen shows a warning on first launch."
        : "서명되지 않은 앱이라 처음 실행 시 Microsoft Defender SmartScreen 경고가 표시됩니다.",
      steps: [
        {
          label: en
            ? "Run the installer you downloaded."
            : "다운로드한 설치 파일을 실행합니다.",
        },
        {
          label: en
            ? "When the “Windows protected your PC” dialog appears, click More info."
            : "“Windows의 PC 보호” 창이 뜨면 추가 정보(More info)를 클릭합니다.",
        },
        {
          label: en
            ? "Click the Run anyway button that appears."
            : "나타나는 실행(Run anyway) 버튼을 클릭합니다.",
        },
      ],
      extraNote: en
        ? "Alternative: right-click the installer → Properties → General tab, check “Unblock,” and the warning won't appear."
        : "대안: 설치 파일을 마우스 오른쪽 → 속성 → 일반 탭에서 “차단 해제”를 체크하면 경고가 나타나지 않습니다.",
    },
    {
      os: "linux",
      osLabel: "Linux",
      title: "AppImage",
      format: "x86_64",
      href: "/download/linux",
      setupNote: en
        ? "The AppImage needs no installation — just grant it execute permission."
        : "AppImage는 설치가 필요 없습니다. 실행 권한만 부여하면 됩니다.",
      steps: [
        {
          label: en ? "Grant execute permission" : "실행 권한 부여",
          command: "chmod +x LVIS-*-linux-x86_64.AppImage",
        },
        {
          label: en ? "Launch" : "실행",
          command: "./LVIS-*-linux-x86_64.AppImage",
        },
        {
          label: en
            ? "If you hit an “AppImages require FUSE to run” error, install FUSE 2."
            : "“AppImages require FUSE to run” 오류가 나면 FUSE 2를 설치합니다.",
          command: "sudo apt install libfuse2",
        },
      ],
      extraNote: en
        ? "On Ubuntu 24.04+ use libfuse2t64; on Fedora use sudo dnf install fuse fuse-libs."
        : "Ubuntu 24.04+는 libfuse2t64, Fedora는 sudo dnf install fuse fuse-libs를 사용하세요.",
    },
  ];
}
