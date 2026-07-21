import type { Metadata } from "next";
import { Hero } from "@/components/landing/hero";
import { About } from "@/components/landing/about";
import { Workday } from "@/components/landing/workday";
import { Downloads } from "@/components/landing/downloads";
import { Architecture } from "@/components/landing/architecture";
import { Surfaces } from "@/components/landing/surfaces";
import { Roadmap } from "@/components/landing/roadmap";
import { Cta } from "@/components/landing/cta";

export const metadata: Metadata = {
  title: "LVIS AI — 조용한 관찰, 정확한 제안, 당신의 승인",
  alternates: { canonical: "/" },
};

export default function LandingPage() {
  return (
    <>
      <Hero locale="ko" />
      <About locale="ko" />
      <Workday locale="ko" />
      <Downloads locale="ko" />
      <Architecture locale="ko" />
      <Surfaces locale="ko" />
      <Roadmap locale="ko" />
      <Cta locale="ko" />
    </>
  );
}
