import type { Locale } from "./i18n";

/** Chrome-level UI strings (header/footer/sidebar/toc/page-nav/search). */
export const ui = {
  ko: {
    nav: { workday: "하루 일과", download: "다운로드", architecture: "아키텍처", roadmap: "로드맵", docs: "문서" },
    downloadApp: "앱 다운로드",
    skipToContent: "본문으로 건너뛰기",
    searchPlaceholder: "검색...",
    openSearch: "검색 열기 (⌘K)",
    onThisPage: "On this page",
    prev: "이전",
    next: "다음",
    sidebarLabel: "문서 사이드바",
    tocLabel: "페이지 목차",
    footerTagline:
      "앱 · 플러그인 · 에이전트 허브가 같은 사용자 신호 위에서 함께 움직이는 업무 AI. 실제 소스에서 검증된 통합 가이드.",
    footerProduct: "제품",
    footerDocs: "문서",
    footerHome: "홈",
    footerLinks: { start: "시작하기", plugins: "플러그인", architecture: "아키텍처", roadmap: "로드맵" },
  },
  en: {
    nav: { workday: "A Day with LVIS", download: "Download", architecture: "Architecture", roadmap: "Roadmap", docs: "Docs" },
    downloadApp: "Download app",
    skipToContent: "Skip to content",
    searchPlaceholder: "Search...",
    openSearch: "Open search (⌘K)",
    onThisPage: "On this page",
    prev: "Previous",
    next: "Next",
    sidebarLabel: "Docs sidebar",
    tocLabel: "Table of contents",
    footerTagline:
      "A work AI where the app, plugins, and the agent hub move together on the same user signals. A unified guide verified against the actual source.",
    footerProduct: "Product",
    footerDocs: "Docs",
    footerHome: "Home",
    footerLinks: { start: "Getting started", plugins: "Plugins", architecture: "Architecture", roadmap: "Roadmap" },
  },
} satisfies Record<Locale, unknown>;

export function uiStrings(locale: Locale) {
  return ui[locale];
}
