export function looksLikeEndpointUrl(value: unknown): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

export function isApiKeyLikeSecretField(key: string): boolean {
  return /(?:apiKey|api_key|token|secret|key)$/i.test(key) || /(?:^|[._-])(?:apiKey|api_key|token|secret|key)(?:$|[._-])/i.test(key);
}

export function validateApiKeyLikeSecretValue(input: {
  key: string;
  value: string;
}): boolean {
  return looksLikeEndpointUrl(input.value) && isApiKeyLikeSecretField(input.key);
}

export function shouldBlockPluginSecretRead(input: {
  pluginId: string;
  storageKey: string;
  value: string | null;
}): boolean {
  if (input.value === null) return false;
  const prefix = `plugin.${input.pluginId}.`;
  if (!input.storageKey.startsWith(prefix)) return false;
  const fieldKey = input.storageKey.slice(prefix.length);
  return validateApiKeyLikeSecretValue({ key: fieldKey, value: input.value });
}