/**
 * Strip `<untrusted-*>` and `</untrusted-*>` tags from plugin-authored
 * prompt text for **display** in user-visible UI (toast / overlay card).
 *
 * Plugin SDK 의 `wrapUntrusted(tag, value, maxLen)` 가 LLM 의 prompt
 * injection 방어를 위해 `<untrusted-meeting-title>...</untrusted-meeting-title>`
 * 같은 XML-like wrapper 를 만든다. LLM 은 그 wrapper 를 보고 "data, not
 * instructions" 로 인지하지만, 사용자 UI 에 raw 노출되면 boilerplate 가 보여
 * UX 가 떨어진다.
 *
 * 이 함수는 *display 시점에만* wrapper 를 제거. inner 컨텐츠는 그대로 유지.
 * LLM 입력 (chat envelope) 에는 *적용하지 않음* — wrapper 가 거기서는
 * 보안 기능을 한다.
 *
 * Matches only the `untrusted-` namespace tag class. Other XML-like
 * substrings in user content are left intact (less aggressive than a
 * generic HTML strip).
 */
const UNTRUSTED_TAG_RE = /<\/?untrusted-[a-z0-9-]+>/g;

export function stripUntrustedTags(text: string): string {
  if (!text) return text;
  return text.replace(UNTRUSTED_TAG_RE, "");
}
