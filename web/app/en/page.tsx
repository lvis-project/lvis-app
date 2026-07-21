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
  title: "LVIS AI — Quiet observation, precise suggestions, your approval",
  alternates: { canonical: "/en" },
};

export default function LandingPageEn() {
  return (
    <>
      <Hero locale="en" />
      <About locale="en" />
      <Workday locale="en" />
      <Downloads locale="en" />
      <Architecture locale="en" />
      <Surfaces locale="en" />
      <Roadmap locale="en" />
      <Cta locale="en" />
    </>
  );
}
