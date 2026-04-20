export function findLvisProtocolUri(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("lvis://")) ?? null;
}
