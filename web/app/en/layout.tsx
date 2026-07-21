import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "LVIS AI — Quiet observation, precise suggestions, your approval",
    template: "%s · LVIS AI",
  },
  description:
    "LVIS AI quietly observes signals from mail, meetings, documents, and calendars, and suggests only at the right moment. Write actions always start with your approval.",
  openGraph: {
    title: "LVIS AI — Quiet observation, precise suggestions",
    description:
      "Signals stay quiet; execution starts with your approval. LVIS, the desktop AI workspace.",
    type: "website",
    siteName: "LVIS AI",
  },
};

/** English tree — Korean stays at the root; <html lang> is ko, so mark the subtree. */
export default function EnLayout({ children }: { children: React.ReactNode }) {
  return <div lang="en">{children}</div>;
}
