/**
 * Caret-context detection for the composer's inline autocomplete menus — "/" for
 * commands, "@" for MCP resource mentions.
 *
 * Given the composer's full text and the current caret index, decide whether
 * the caret sits inside an active trigger token — and if so, return that
 * token's range and the query typed after the sigil. A menu opens
 * exactly when its detector returns non-null.
 *
 * This is the single behavioural decision the whole feature hinges on: every
 * downstream step (filtering, highlight, accept/replace) is mechanical once we
 * know the trigger range. Keeping it isolated + pure makes it trivial to unit
 * test and to tune the activation rule without touching the menu.
 */

export interface SlashTrigger {
  /** The query typed after the leading "/" (does NOT include the slash). */
  query: string;
  /** Index of the leading "/" in `text` (inclusive). */
  start: number;
  /** Index where the query ends — i.e. the caret position (exclusive). */
  end: number;
}

/**
 * Return the active slash trigger at the caret, or null when no menu should
 * show.
 *
 * Activation rule (chat-composer convention, matches Slack/Discord):
 *   - The "/" must START a token: it is valid only at the start of the whole
 *     text, or immediately after whitespace (a space or a newline). This keeps
 *     "https://" and "TCP/IP" from ever opening the menu.
 *   - The query is the unbroken run of non-whitespace characters between the
 *     "/" and the caret. A space or newline between the "/" and the caret ends
 *     the token, so the menu closes once the user types past the command.
 */
export function detectSlashQuery(text: string, caret: number): SlashTrigger | null {
  return detectTriggerQuery(text, caret, "/");
}

/**
 * The same rule for the "@" mention menu, which offers MCP server resources.
 *
 * Shares the activation rule rather than restating it, so the two menus cannot drift
 * into answering "is this a trigger" differently — and so `foo@example.com` never opens
 * the picker, for exactly the reason `https://` never opens the slash menu: the sigil
 * has to START a token.
 */
export function detectMentionQuery(text: string, caret: number): SlashTrigger | null {
  return detectTriggerQuery(text, caret, "@");
}

function detectTriggerQuery(text: string, caret: number, sigil: string): SlashTrigger | null {
  if (caret < 1 || caret > text.length) return null;

  // Scan backwards from the caret to the nearest sigil. Any whitespace between
  // the caret and it ends the token (no active trigger).
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === sigil) break;
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    i -= 1;
  }
  if (i < 0 || text[i] !== sigil) return null;

  // The sigil must start a token: at text start, or right after whitespace.
  const before = i === 0 ? "" : text[i - 1];
  if (before !== "" && before !== " " && before !== "\n" && before !== "\t") {
    return null;
  }

  return { query: text.slice(i + 1, caret), start: i, end: caret };
}
