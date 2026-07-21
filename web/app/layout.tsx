import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/docs/header";
import { AppFrame } from "@/components/docs/app-frame";
import { CommandPaletteProvider } from "@/components/docs/command-palette";
import { ScrollProgress } from "@/components/motion/scroll-progress";
import { SkipLink } from "@/components/docs/skip-link";
import { SiteFooter } from "@/components/docs/site-footer";

export const metadata: Metadata = {
  title: {
    default: "LVIS AI — 조용한 관찰, 정확한 제안, 당신의 승인",
    template: "%s · LVIS AI",
  },
  description:
    "LVIS AI는 메일·회의·문서·일정의 신호를 조용히 관찰하고, 적절한 순간에만 제안합니다. 쓰기 작업은 언제나 당신의 승인으로 시작됩니다.",
  metadataBase: new URL("https://lvisai.xyz"),
  openGraph: {
    title: "LVIS AI — 조용한 관찰, 정확한 제안",
    description:
      "신호는 조용히, 실행은 당신의 승인으로. 데스크톱 AI 워크스페이스 LVIS.",
    type: "website",
    siteName: "LVIS AI",
  },
  icons: {
    icon: "/favicon.svg",
  },
  manifest: "/site.webmanifest",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="min-h-dvh">
        <noscript>
          {/* Keep scroll-reveal content visible without JS. */}
          <style>{`.reveal{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
        <SkipLink />
        <CommandPaletteProvider>
          <ScrollProgress />
          <Header />
          <AppFrame>{children}</AppFrame>
        </CommandPaletteProvider>

        <SiteFooter />
      </body>
    </html>
  );
}
