/**
 * Permission policy Layer 8 slash-origin sanitizer.
 *
 * Non-user-origin text can be displayed or sent as ordinary prompt text, but
 * it must not retain a leading slash that would dispatch host commands.
 */
export function stripLeadingSlash(input: string): string {
  let output = input;
  while (output.trimStart().startsWith("/")) {
    const leading = output.match(/^\s*/)?.[0] ?? "";
    const rest = output.slice(leading.length);
    output = `${leading}${rest.replace(/^\/+\s*/, "")}`;
  }
  return output;
}
