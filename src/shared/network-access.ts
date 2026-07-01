import { normalizeAllowedHosts } from "../main/host-allow-list.js";

export type NetworkAccessGrant = {
  allowedDomains?: readonly string[];
  reasoning?: string;
  allowPrivateNetworks?: boolean;
};

export type NormalizedNetworkAccessGrant = {
  allowedDomains: string[];
  reasoning?: string;
  allowPrivateNetworks?: true;
};

export type NetworkAccessAcknowledgement = {
  allowedDomains: string[];
  allowPrivateNetworks?: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function mapNetworkAccessGrant(value: unknown): NormalizedNetworkAccessGrant | undefined {
  if (!isRecord(value)) return undefined;
  const allowedDomainsRaw = value.allowed_domains ?? value.allowedDomains;
  return normalizeNetworkAccessGrant({
    allowedDomains: stringArray(allowedDomainsRaw),
    reasoning: typeof value.reasoning === "string" ? value.reasoning : undefined,
    allowPrivateNetworks: value.allow_private_networks === true || value.allowPrivateNetworks === true,
  });
}

export function normalizeNetworkAccessGrant(
  value: NetworkAccessGrant | null | undefined,
): NormalizedNetworkAccessGrant | undefined {
  const allowedDomains = normalizeAllowedHosts(value?.allowedDomains ?? []);
  const reasoning = typeof value?.reasoning === "string" && value.reasoning.trim().length > 0
    ? value.reasoning.trim()
    : undefined;
  const allowPrivateNetworks = value?.allowPrivateNetworks === true;
  if (allowedDomains.length === 0 && !reasoning && !allowPrivateNetworks) return undefined;
  return {
    allowedDomains,
    ...(reasoning ? { reasoning } : {}),
    ...(allowPrivateNetworks ? { allowPrivateNetworks: true as const } : {}),
  };
}

export function hasNetworkAccessDisclosure(value: NetworkAccessGrant | null | undefined): boolean {
  const normalized = normalizeNetworkAccessGrant(value);
  return !!normalized && (
    normalized.allowedDomains.length > 0 ||
    !!normalized.reasoning ||
    normalized.allowPrivateNetworks === true
  );
}

export function buildNetworkAccessAcknowledgement(
  value: NetworkAccessGrant | null | undefined,
): NetworkAccessAcknowledgement | undefined {
  const normalized = normalizeNetworkAccessGrant(value);
  if (!normalized) return undefined;
  return {
    allowedDomains: [...normalized.allowedDomains].sort(),
    ...(normalized.allowPrivateNetworks === true ? { allowPrivateNetworks: true as const } : {}),
  };
}

export function networkAccessGrantsEqual(
  expected: NetworkAccessGrant | null | undefined,
  actual: NetworkAccessGrant | null | undefined,
): boolean {
  const expectedGrant = buildNetworkAccessAcknowledgement(expected) ?? null;
  const actualGrant = buildNetworkAccessAcknowledgement(actual) ?? null;
  return JSON.stringify(actualGrant) === JSON.stringify(expectedGrant);
}
