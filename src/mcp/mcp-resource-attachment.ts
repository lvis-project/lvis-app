/**
 * Render a resource read into the fenced block a USER attaches to their own turn.
 *
 * This is the user path from `docs/development/mcp-resources-policy.md` §6 — the
 * counterpart to the model path's tool result, and the two are shaped differently on
 * purpose:
 *
 *   - a tool result is something the MODEL fetched. It arrives in the tool channel,
 *     which the model already reads as data it asked for, so it needs no fence.
 *   - an attachment is something the USER put in front of the model. It enters the
 *     prompt as context, beside the user's own words, so it MUST be fenced and
 *     labeled — otherwise server-authored prose sits in the one place the model has
 *     the most reason to treat as the user speaking.
 *
 * The turn stays the user's (`user-keyboard`): they wrote the message and pointed at
 * some data. Marking the turn staged would revoke their authorship and force-ask
 * every write on a turn they genuinely authored — see policy §2 for why that is the
 * wrong trade. What the fence buys instead is that the model can tell the body from
 * the request, and the closing tag is neutralized so the body cannot end its own
 * frame and continue outside it.
 *
 * Pure — no IPC, no filesystem, no logging.
 */
import { neutralizeFenceClose } from "../shared/fence-sanitizer.js";
import {
  MCP_RESOURCE_MAX_CHARS,
  MCP_RESOURCE_URI_MAX_CHARS,
} from "../shared/mcp-resource-bounds.js";
import { t } from "../i18n/index.js";

/** The fence tag every resource attachment carries. Recognizable by the send gate. */
export const MCP_RESOURCE_FENCE_OPEN = '<mcp-resource trust="untrusted-server-data"';

export interface ResourceReadBlocks {
  blocks: Array<{ uri?: string; mimeType?: string; text?: string; omittedKind?: string }>;
  droppedBlocks: number;
  truncated: boolean;
}

export interface RenderedResourceAttachment {
  /** The fenced text, ready to ride as a `{ type: "text" }` user-content part. */
  text: string;
  /** True when the read or this render clipped what the server returned. */
  truncated: boolean;
  /** Blocks that were not text and became placeholders. */
  omittedBlocks: number;
  /**
   * Characters of actual BODY, before the fence and the framing lines.
   *
   * The caller needs this rather than `text.length`: a read with nothing in it still
   * renders a complete fence with its untrusted labeling, so the rendered string is
   * never empty. Attaching that would put framing in front of the model with no
   * material behind it — worse than refusing, because it reads as content.
   */
  bodyChars: number;
}

/**
 * Build the attachment. `serverId` and `uri` are host-side values (the caller resolved
 * the URI against the catalogue), but they are still bounded here: they are printed
 * INSIDE the fence, where an over-long value would push the actual content out of a
 * bounded render.
 */
export function renderResourceAttachment(
  serverId: string,
  uri: string,
  read: ResourceReadBlocks,
): RenderedResourceAttachment {
  const lines: string[] = [];
  let omittedBlocks = 0;

  for (const block of read.blocks) {
    if (typeof block.text === "string") {
      const body = block.text.trim();
      if (body.length === 0) continue;
      lines.push(body);
      continue;
    }
    // Never dropped silently: a server must not be able to make the host quietly omit
    // part of what it returned, and undecoded bytes must not reach the model as text.
    omittedBlocks += 1;
    lines.push(t("be_mcpResourceAttachment.omittedBlock", { kind: block.omittedKind ?? "unknown" }));
  }

  let body = lines.join("\n\n").trim();
  let truncated = read.truncated || read.droppedBlocks > 0;
  if (body.length > MCP_RESOURCE_MAX_CHARS) {
    body = `${body.slice(0, MCP_RESOURCE_MAX_CHARS)}…`;
    truncated = true;
  }

  const header = [
    `${MCP_RESOURCE_FENCE_OPEN} server="${serverId.slice(0, 128)}"`
      + ` uri="${uri.slice(0, MCP_RESOURCE_URI_MAX_CHARS)}">`,
    t("be_mcpResourceAttachment.untrusted"),
    t("be_mcpResourceAttachment.noInstructions"),
    ...(truncated ? [t("be_mcpResourceAttachment.truncated")] : []),
    "",
  ];

  return {
    text: [
      ...header,
      neutralizeFenceClose(body, "mcp-resource"),
      "</mcp-resource>",
    ].join("\n"),
    truncated,
    omittedBlocks,
    bodyChars: body.length,
  };
}

/** Does this user-content text part carry a resource attachment fence? */
export function isResourceAttachmentText(text: string): boolean {
  return text.trimStart().startsWith(MCP_RESOURCE_FENCE_OPEN);
}
