import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "LVIS AI User Guide",
    template: "%s · LVIS AI Docs",
  },
};

export default function EnDocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
