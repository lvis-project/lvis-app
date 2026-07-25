/**
 * useResourceMention — the composer's `@` picker for MCP server resources.
 *
 * Sibling of `use-inline-slash-menu` and deliberately shaped like it (trigger → items →
 * open/move/accept/close), sharing the activation rule through `detectMentionQuery` so
 * the two menus cannot disagree about what a trigger is.
 *
 * What is NOT like the slash menu: every item there applies DRAFT TEXT the user then
 * submits. Accepting a resource instead performs an IPC read and attaches the host-built
 * fenced block as its own content part, because that text is the server's, not the
 * user's. The hook therefore owns an async accept and the failure modes that come with
 * it, and the marker it puts in the body is a reference — never the content.
 *
 * The catalogue comes from `listResources` and `listResourceTemplates` (the host's ONE
 * projection each). The picker never derives "which resources are attachable" from server
 * state itself: a second answer to that question is how a picker starts offering URIs the
 * read path refuses.
 *
 * Two kinds of row, and the difference is the whole reason this hook has a second state
 * machine. A resource row is a finished identifier and accepting it reads. A TEMPLATE row
 * is an offer — the user has to fill it in — so accepting it opens a host dialog and the
 * read happens on submit. The renderer never builds the URI: it hands back the template
 * and the values, and main expands. (`mcp-resources-policy.md` §3.)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_NAME_MAX_CHARS,
} from "../../../shared/mcp-resource-bounds.js";

import { displaySafeLabel } from "../../../shared/display-safe-text.js";
import { detectMentionQuery } from "../utils/slash-trigger.js";
import { resolveIpcErrorKey } from "../format-ipc-error.js";
import type { LvisApi } from "../types.js";
import type { ResourceAttachment } from "../types/attachments.js";

/**
 * Rows the menu will render at once.
 *
 * A server may publish 200 resources and several may be connected, so an empty query
 * matches everything: without a bound, typing `@` builds a thousand unvirtualized DOM
 * rows before the user has typed a letter of what they want. The query is how you reach
 * the rest, which is what an autocomplete is for.
 */
const MENTION_MAX_ROWS = 50;

/**
 * What accepting a row does, as a closed union rather than two optional fields.
 *
 * A resource carries a finished URI; a template carries the PATTERN and the variables to
 * ask for. Written this way so no code path can read a `uri` off a template row — the
 * distinction is the difference between a read and a form, and the two channels take
 * different arguments for a reason main enforces.
 */
type ResourceMentionTarget =
  | { kind: "resource"; uri: string }
  | { kind: "template"; uriTemplate: string; variables: readonly string[] };

/** One offered row, already display-normalized. */
export interface ResourceMentionItem {
  key: string;
  serverId: string;
  /** The URI to read, or the template to fill — passed back UNCHANGED either way. */
  target: ResourceMentionTarget;
  /** Label for the eye: name/title, invisible and reordering characters removed. */
  label: string;
  /** Secondary text: `serverId` plus the same treatment of the URI or template. */
  hint: string;
  /**
   * Why this row cannot be attached right now, or `undefined` when it can.
   *
   * Lives on the ROW, not in the projection. `listDeclaredResources` answers "what did
   * the host catalogue" — the model-facing tool wants those rows listed, and one of them
   * is a resource the spec says the CLIENT fetches directly, which the host refuses to
   * fetch on its behalf. The picker answers a different question, "what can be attached
   * right now", and that is the one a user is asking when they type `@`.
   */
  unavailableReason?: string;
}

export interface UseResourceMentionArgs {
  text: string;
  caret: number;
  enabled: boolean;
  isComposing: boolean;
  mcp: LvisApi["mcp"] | undefined;
  /** Resource attachments already in the composer — the cap is per turn. */
  resourceCount: number;
  allocateN: () => number;
  /**
   * Commit the attachment and the marker TOGETHER. The Composer owns this because the
   * two have to land in one `flushSync`: the marker-sync effect treats an attachment
   * with no marker in the body as removed and would clean it straight back up.
   */
  onAttach: (
    attachment: ResourceAttachment,
    marker: string,
    range: { start: number; end: number },
    /** The exact token the range held when the read started, for a stale check. */
    mentionToken: string,
  ) => void;
  onError: (message: string) => void;
}

/**
 * A template row the user accepted, waiting on the form.
 *
 * Carries the composer position captured at ACCEPT time, because the read happens after
 * a dialog the user may have spent a minute in. The Composer's `onAttach` re-checks that
 * position against the live text and appends instead of splicing when it has moved, so
 * this is a hint, never an authority.
 */
export interface PendingResourceTemplate {
  serverId: string;
  uriTemplate: string;
  variables: readonly string[];
  label: string;
  range: { start: number; end: number };
  mentionToken: string;
}

export interface UseResourceMentionResult {
  open: boolean;
  items: ResourceMentionItem[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  move: (delta: number) => void;
  accept: (index?: number) => void;
  close: () => void;
  /** The template awaiting values, or null. The Composer renders the dialog for it. */
  pendingTemplate: PendingResourceTemplate | null;
  /** Fill it and read. Values are the user's, keyed by the template's variable names. */
  submitTemplate: (values: Record<string, string>) => void;
  cancelTemplate: () => void;
}

interface CatalogueEntry {
  serverId: string;
  target: ResourceMentionTarget;
  label: string;
  hint: string;
  /** Lowercased haystack for matching: label + serverId + uri (or template). */
  search: string;
  unavailableReason?: string;
}

/** Stable identity for a row, and the React key. */
function targetId(target: ResourceMentionTarget): string {
  return target.kind === "resource" ? target.uri : target.uriTemplate;
}

export function useResourceMention({
  text,
  caret,
  enabled,
  isComposing,
  mcp,
  resourceCount,
  allocateN,
  onAttach,
  onError,
}: UseResourceMentionArgs): UseResourceMentionResult {
  const { t } = useTranslation();
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<PendingResourceTemplate | null>(null);
  // Guards a second read while one is in flight: the accept path is async and a user
  // can hit Enter twice, which would attach the same resource under two markers.
  const attachingRef = useRef(false);

  const trigger = useMemo(
    () => (enabled && !isComposing ? detectMentionQuery(text, caret) : null),
    [enabled, isComposing, text, caret],
  );
  const triggerKey = trigger ? `${trigger.start}:${trigger.end}:${trigger.query}` : null;
  const active = trigger !== null;

  // Refetched whenever a mention token appears rather than cached for the session: a
  // server connects or drops between two messages, and a catalogue that outlives the
  // connection offers URIs whose read can only fail.
  //
  // Both halves in ONE effect with one `cancelled` flag. Two effects would each set the
  // catalogue and the second to land would erase the first's rows — resources and
  // templates are one list to the user, so they are one fetch here.
  useEffect(() => {
    if (!active || !mcp?.listResources) return;
    let cancelled = false;
    void (async () => {
      try {
        const [resources, templates] = await Promise.all([
          mcp.listResources(),
          // Guarded the same way the line above guards `listResources`, and for a
          // consequence rather than a version story: a missing method inside
          // `Promise.all` throws, the catch below empties the catalogue, and the user
          // loses their RESOURCES because templates were unavailable. Degrading to
          // resources-only is the honest failure.
          mcp.listResourceTemplates?.() ?? Promise.resolve({ ok: false as const, error: "" }),
        ]);
        if (cancelled) return;
        const flat: CatalogueEntry[] = [];
        if (resources.ok) {
          for (const server of resources.servers) {
            for (const resource of server.resources) {
              const label =
                displaySafeLabel(resource.title, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(resource.name, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(resource.uri, MCP_RESOURCE_NAME_MAX_CHARS);
              const safeUri = displaySafeLabel(resource.uri, MCP_RESOURCE_NAME_MAX_CHARS);
              flat.push({
                serverId: server.serverId,
                target: { kind: "resource", uri: resource.uri },
                label,
                hint: `${server.serverId} · ${safeUri}`,
                search: `${label} ${server.serverId} ${safeUri}`.toLowerCase(),
                // Shown and disabled rather than hidden. A user whose `https:` resource
                // silently vanished from the picker would report the picker as broken; a row
                // that says why is the difference between a bug and an explanation.
                ...(resource.hostFetchRefused
                  ? { unavailableReason: t("composer.resourceNotFetchable") }
                  : {}),
              });
            }
          }
        }
        if (templates.ok) {
          for (const server of templates.servers) {
            for (const template of server.templates) {
              const label =
                displaySafeLabel(template.title, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(template.name, MCP_RESOURCE_NAME_MAX_CHARS)
                || displaySafeLabel(template.uriTemplate, MCP_RESOURCE_NAME_MAX_CHARS);
              const safeTemplate = displaySafeLabel(
                template.uriTemplate,
                MCP_RESOURCE_NAME_MAX_CHARS,
              );
              // `variables` comes from the HOST's discovery, derived once from the
              // template it catalogued. Deriving it here from the string would be a
              // second parser for the same grammar, and the form and the expansion
              // would eventually disagree about what the template asks for.
              flat.push({
                serverId: server.serverId,
                target: {
                  kind: "template",
                  uriTemplate: template.uriTemplate,
                  variables: template.variables,
                },
                label,
                hint: `${server.serverId} · ${safeTemplate}`,
                search: `${label} ${server.serverId} ${safeTemplate}`.toLowerCase(),
              });
            }
          }
        }
        setCatalogue(flat);
      } catch {
        // A failed catalogue read is an empty menu, not an error toast: the user typed
        // "@" and may not have meant a resource at all.
        if (!cancelled) setCatalogue([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, mcp, t]);

  const items = useMemo<ResourceMentionItem[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    const matched = query.length === 0
      ? catalogue
      : catalogue.filter((entry) => entry.search.includes(query));
    return matched.slice(0, MENTION_MAX_ROWS).map((entry) => ({
      key: `${entry.serverId}::${entry.target.kind}::${targetId(entry.target)}`,
      serverId: entry.serverId,
      target: entry.target,
      label: entry.label,
      hint: entry.hint,
      ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
    }));
  }, [trigger, catalogue]);

  useEffect(() => {
    setActiveIndex(0);
  }, [triggerKey]);

  const open = trigger !== null && items.length > 0 && dismissedToken !== triggerKey;

  const move = useCallback((delta: number) => {
    setActiveIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length));
  }, [items.length]);

  const close = useCallback(() => {
    setDismissedToken(triggerKey);
  }, [triggerKey]);

  /**
   * The read, shared by both kinds of row.
   *
   * One place decides what an attachment looks like and how a failure is reported, so a
   * template attachment cannot drift into a different chip, a different marker, or a
   * hand-written error mapping. Only the round trip differs, and the caller supplies it.
   */
  const runAttach = useCallback((
    context: {
      serverId: string;
      label: string;
      uri: string;
      range: { start: number; end: number };
      mentionToken: string;
    },
    read: () => Promise<
      | { ok: true; attachment: { text: string }; uri?: string; truncated?: boolean }
      | { ok: false; error: string }
    >,
  ) => {
    if (attachingRef.current) return;
    attachingRef.current = true;
    void (async () => {
      try {
        const result = await read();
        if (!result.ok) {
          // Through the SAME code table the rest of the app uses, rather than a second
          // hand-written mapping here. Stage 3a already registered every code this
          // handler can return (`empty-resource`, `resource-failed`, `invalid-request`,
          // `rate-limited`, `invalid-server-id`); collapsing them to one sentence told
          // a user who had simply gone too fast that their server may have
          // disconnected — a wrong answer, not a vague one. `rate-limited` keeps its own
          // string because that is the one a person can act on.
          const mapped = resolveIpcErrorKey(result.error);
          onError(t(mapped ?? "composer.resourceAttachFailed"));
          return;
        }
        const n = allocateN();
        onAttach(
          {
            id: `res-${context.serverId}-${n}`,
            n,
            kind: "resource",
            serverId: context.serverId,
            // For a template this is the URI MAIN produced, echoed back for the chip.
            // The renderer never composes it — it has no channel that would take one.
            uri: result.uri ?? context.uri,
            label: context.label,
            text: result.attachment.text,
            truncated: result.truncated === true,
          },
          `[Resource #${n}] `,
          context.range,
          context.mentionToken,
        );
      } catch {
        onError(t("composer.resourceAttachFailed"));
      } finally {
        attachingRef.current = false;
      }
    })();
  }, [allocateN, onAttach, onError, t]);

  const accept = useCallback((index?: number) => {
    if (!trigger || !mcp?.attachResource) return;
    const item = items[index ?? activeIndex];
    if (!item) return;
    // A row the read would refuse says so instead of spending a round-trip to fail.
    if (item.unavailableReason) {
      onError(item.unavailableReason);
      return;
    }
    // Capped in the UI at the SAME number main enforces, so the user is stopped by a
    // message naming the limit instead of by a refused send at the end of the turn.
    // Checked again when a template's form is submitted, because the answer can change
    // while that form is open.
    if (resourceCount >= MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
      onError(t("composer.resourceLimit", { max: MCP_RESOURCE_ATTACHMENTS_PER_TURN }));
      return;
    }
    const range = { start: trigger.start, end: trigger.end };
    const mentionToken = text.slice(trigger.start, trigger.end);
    if (item.target.kind === "template") {
      if (!mcp.attachResourceTemplate) {
        onError(t("composer.resourceAttachFailed"));
        return;
      }
      // No read yet — a template is an offer. The menu is dismissed here so it is not
      // sitting open behind the dialog, and the position is captured now because the
      // user is about to spend time in a form.
      setDismissedToken(triggerKey);
      setPendingTemplate({
        serverId: item.serverId,
        uriTemplate: item.target.uriTemplate,
        variables: item.target.variables,
        label: item.label,
        range,
        mentionToken,
      });
      return;
    }
    const uri = item.target.uri;
    runAttach(
      { serverId: item.serverId, label: item.label, uri, range, mentionToken },
      () => mcp.attachResource(item.serverId, uri),
    );
  }, [trigger, triggerKey, items, activeIndex, mcp, resourceCount, onError, runAttach, t, text]);

  const cancelTemplate = useCallback(() => setPendingTemplate(null), []);

  const submitTemplate = useCallback((values: Record<string, string>) => {
    const pending = pendingTemplate;
    if (!pending || !mcp?.attachResourceTemplate) return;
    setPendingTemplate(null);
    // Re-checked, not inherited from the accept: the form was open while the rest of the
    // composer stayed live, and a user can add attachments from another surface in that
    // time. Refusing here costs a message; not refusing costs a send.
    if (resourceCount >= MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
      onError(t("composer.resourceLimit", { max: MCP_RESOURCE_ATTACHMENTS_PER_TURN }));
      return;
    }
    runAttach(
      {
        serverId: pending.serverId,
        label: pending.label,
        // Only a fallback for the chip if main ever stops echoing the expansion; the
        // renderer cannot expand the template itself and does not try.
        uri: pending.uriTemplate,
        range: pending.range,
        mentionToken: pending.mentionToken,
      },
      () => mcp.attachResourceTemplate(pending.serverId, pending.uriTemplate, values),
    );
  }, [mcp, onError, pendingTemplate, resourceCount, runAttach, t]);

  return {
    open,
    items,
    activeIndex,
    setActiveIndex,
    move,
    accept,
    close,
    pendingTemplate,
    submitTemplate,
    cancelTemplate,
  };
}
