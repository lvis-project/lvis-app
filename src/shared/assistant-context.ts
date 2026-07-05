export const MARKETPLACE_PACKAGE_TYPES = [
  "plugin",
  "mcp",
  "agent",
  "skill",
  "provider",
  "theme",
  "language-pack",
] as const;

export type MarketplacePackageType = (typeof MARKETPLACE_PACKAGE_TYPES)[number];

export const INSTALLABLE_MARKETPLACE_PACKAGE_TYPES = [
  "plugin",
  "mcp",
  "agent",
  "skill",
] as const satisfies readonly MarketplacePackageType[];

export type InstallableMarketplacePackageType =
  (typeof INSTALLABLE_MARKETPLACE_PACKAGE_TYPES)[number];

const MARKETPLACE_PACKAGE_TYPE_SET = new Set<string>(MARKETPLACE_PACKAGE_TYPES);

export function isMarketplacePackageType(value: unknown): value is MarketplacePackageType {
  return typeof value === "string" && MARKETPLACE_PACKAGE_TYPE_SET.has(value);
}

export interface AssistantAgentSummary {
  name: string;
  description: string;
  sourceTools: string[];
  triggers: string[];
  model?: string;
  mode?: string;
}

export interface AssistantSkillSummary {
  name: string;
  description: string;
  triggers: string[];
}
