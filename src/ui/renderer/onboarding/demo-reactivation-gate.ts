import type { AppSettings } from "../types.js";

export type DemoStatusProbe =
  | { ok: true; activated: boolean; vendor: string | null }
  | { ok: false; error: string };

export function shouldOpenDemoReactivationOnBoot(
  settings: Pick<AppSettings, "llm">,
  demoStatus: DemoStatusProbe | null,
): boolean {
  if (settings.llm.authMode !== "login") return false;
  if (settings.llm.provider !== "azure-foundry") return false;
  if (demoStatus === null || !demoStatus.ok) return false;
  return demoStatus.activated === false;
}
