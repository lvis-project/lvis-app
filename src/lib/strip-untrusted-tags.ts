



const UNTRUSTED_TAG_RE = /<\/?untrusted-[a-z0-9-]+>/g;

export function stripUntrustedTags(text: string): string {
  if (!text) return text;
  return text.replace(UNTRUSTED_TAG_RE, "");
}
