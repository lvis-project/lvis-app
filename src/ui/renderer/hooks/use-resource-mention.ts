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
 * The catalogue comes from `listResources` (the host's ONE projection). The picker never
 * derives "which resources are attachable" from server state itself: a second answer to
 * that question is how a picker starts offering URIs the read path refuses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import {
  MCP_RESOURCE_ATTACHMENTS_PER_TURN,
  MCP_RESOURCE_NAME_MAX_CHARS,
} from "../../../shared/mcp-resource-bounds.js";
import { displaySafeLabel } from "../../../shared/display-safe-text.js";
import { detectMentionQuery } from "../utils/slash-trigger.js";
import type { LvisApi } from "../types.js";
import type { ResourceAttachment } from "../types/attachments.js";

/** One offered resource, already display-normalized. */
export interface ResourceMentionItem {
  key: string;
  serverId: string;
  /** The URI as the server published it — passed back to the read UNCHANGED. */
  uri: string;
  /** Label for the eye: name/title, invisible and reordering characters removed. */
  label: string;
  /** Secondary text: `serverId` plus the same treatment of the URI. */
  hint: string;
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
  ) => void;
  onError: (message: string) => void;
}

export interface UseResourceMentionResult {
  open: boolean;
  items: ResourceMentionItem[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  loading: boolean;
  move: (delta: number) => void;
  accept: (index?: number) => void;
  close: () => void;
}

interface CatalogueEntry {
  serverId: string;
  uri: string;
  label: string;
  hint: string;
  /** Lowercased haystack for matching: label + serverId + uri. */
  search: string;
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
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
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
  useEffect(() => {
    if (!active || !mcp?.listResources) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await mcp.listResources();
        if (cancelled) return;
        if (!result.ok) {
          setCatalogue([]);
          return;
        }
        const flat: CatalogueEntry[] = [];
        for (const server of result.servers) {
          for (const resource of server.resources) {
            const label =
              displaySafeLabel(resource.title, MCP_RESOURCE_NAME_MAX_CHARS)
              || displaySafeLabel(resource.name, MCP_RESOURCE_NAME_MAX_CHARS)
              || displaySafeLabel(resource.uri, MCP_RESOURCE_NAME_MAX_CHARS);
            const safeUri = displaySafeLabel(resource.uri, MCP_RESOURCE_NAME_MAX_CHARS);
            flat.push({
              serverId: server.serverId,
              uri: resource.uri,
              label,
              hint: `${server.serverId} · ${safeUri}`,
              search: `${label} ${server.serverId} ${safeUri}`.toLowerCase(),
            });
          }
        }
        setCatalogue(flat);
      } catch {
        // A failed catalogue read is an empty menu, not an error toast: the user typed
        // "@" and may not have meant a resource at all.
        if (!cancelled) setCatalogue([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, mcp]);

  const items = useMemo<ResourceMentionItem[]>(() => {
    if (!trigger) return [];
    const query = trigger.query.trim().toLowerCase();
    const matched = query.length === 0
      ? catalogue
      : catalogue.filter((entry) => entry.search.includes(query));
    return matched.map((entry) => ({
      key: `${entry.serverId}::${entry.uri}`,
      serverId: entry.serverId,
      uri: entry.uri,
      label: entry.label,
      hint: entry.hint,
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

  const accept = useCallback((index?: number) => {
    if (!trigger || !mcp?.attachResource) return;
    const item = items[index ?? activeIndex];
    if (!item) return;
    // Capped in the UI at the SAME number main enforces, so the user is stopped by a
    // message naming the limit instead of by a refused send at the end of the turn.
    if (resourceCount >= MCP_RESOURCE_ATTACHMENTS_PER_TURN) {
      onError(t("composer.resourceLimit", { max: MCP_RESOURCE_ATTACHMENTS_PER_TURN }));
      return;
    }
    if (attachingRef.current) return;
    attachingRef.current = true;
    const range = { start: trigger.start, end: trigger.end };
    void (async () => {
      try {
        const result = await mcp.attachResource(item.serverId, item.uri);
        if (!result.ok) {
          onError(t("composer.resourceAttachFailed"));
          return;
        }
        const n = allocateN();
        onAttach(
          {
            id: `res-${item.serverId}-${n}`,
            n,
            kind: "resource",
            serverId: item.serverId,
            uri: item.uri,
            label: item.label,
            text: result.attachment.text,
            truncated: result.truncated === true,
            omittedBlocks: result.omittedBlocks ?? 0,
          },
          `[Resource #${n}] `,
          range,
        );
      } catch {
        onError(t("composer.resourceAttachFailed"));
      } finally {
        attachingRef.current = false;
      }
    })();
  }, [trigger, items, activeIndex, mcp, resourceCount, allocateN, onAttach, onError, t]);

  return { open, items, activeIndex, setActiveIndex, loading, move, accept, close };
}
