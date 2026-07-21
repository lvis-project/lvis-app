import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "LVIS AI 사용자 가이드",
    template: "%s · LVIS AI Docs",
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
