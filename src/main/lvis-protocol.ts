export function findLvisProtocolUri(argv: readonly string[]): string | null {
  // Scheme comparison is case-insensitive per RFC 3986 §3.1, so accept e.g. LVIS://...
  return argv.find((arg) => arg.toLowerCase().startsWith("lvis://")) ?? null;
}
