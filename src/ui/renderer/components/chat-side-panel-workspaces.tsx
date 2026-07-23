import { createElement, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { cn } from "../../../lib/utils.js";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ExternalLink,
  File,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Badge } from "../../../components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { formatIpcError } from "../format-ipc-error.js";
import { VerticalSplitLayout } from "./VerticalSplitLayout.js";
import { useVerticalSplit } from "../hooks/use-vertical-split.js";
import { useAddProjectFolder } from "../hooks/use-add-project-folder.js";
import { useNativeContextMenu } from "../hooks/use-native-context-menu.js";
import {
  ListDetailWorkspace,
  SearchInput,
  TargetRows,
} from "./chat-side-panel-layout.js";
import {
  BrowserDocumentViewer,
  DetailHeader,
  EmptyState,
  FileTreeRows,
  PreviewBody,
  UrlDocumentViewer,
  buildFileTree,
  fileBasename,
  fileIcon,
  filterFileTree,
  isPathWithinRoot,
  matchesQuery,
  toRelativePath,
} from "./chat-side-panel-preview.js";


type WorkspaceDirEntry = { name: string; path: string; type: "file" | "directory" };

/**
 * Project-folder browser (diagnosis ③). Lists the persisted project roots
 * (default workspace + Settings `additionalDirectories`) and lets the user add
 * a new one via the native picker. Folders lazy-expand through
 * `window.lvis.workspace.listDir` (scope-revalidated in main); clicking a file
 * routes to `onOpenFile`, which loads its content via the same traversal-guarded
 * preview IPC used everywhere else.
 */
function ProjectRootsBrowser({
  onOpenFile,
  selectedPath,
}: {
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const { t } = useTranslation();
  const openNativeContextMenu = useNativeContextMenu();
  const [roots, setRoots] = useState<Array<{ path: string; isDefault: boolean }>>([]);
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Record<string, WorkspaceDirEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  // A path is "attempted" once loadDir resolves (success OR failure). The
  // auto-load effect keys off this so a dir whose listDir FAILED is not retried
  // forever: a failed listDir never populates childrenByPath, so without this the
  // effect would refire every render → an infinite render→IPC loop.
  const [attemptedPaths, setAttemptedPaths] = useState<Set<string>>(new Set());
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({});
  // Directories whose listing hit MAX_DIR_ENTRIES (main returns `truncated`), so
  // the browser can flag that only a prefix of the folder is shown.
  const [truncatedPaths, setTruncatedPaths] = useState<Set<string>>(new Set());
  // "Add a project folder" (pickRoot + adjacency-warning acknowledgement) is
  // the SAME shared flow the empty-state composer's ComposerProjectSelector
  // uses — see use-add-project-folder.ts. Kept as one implementation so the
  // ack-token state machine cannot drift between the two entry points.
  const {
    pendingWarning,
    addFolder: pickProjectFolder,
    confirmPendingFolder: confirmPendingFolderShared,
    cancelPendingFolder,
    setPendingWarning,
  } = useAddProjectFolder();
  // True while a folder drag hovers the roots panel — drives the drop-zone ring.
  const [dragOver, setDragOver] = useState(false);

  // Roving-tabindex active row (the single treeitem with tabIndex=0). Distinct
  // from `selectedPath` (the OPENED file, drives bg-accent) — this is keyboard
  // focus, not the opened file.
  const [activeItemPath, setActiveItemPath] = useState<string | null>(null);
  // path -> row element, for imperative focus moves (roving tabindex).
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Set true just before a keyboard-driven setActiveItemPath so the post-render
  // effect calls .focus(); prevents stealing focus on mount / mouse clicks.
  const pendingFocusRef = useRef(false);
  // Type-ahead buffer with a 500ms reset window.
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });
  // Inline failure surface for the mutating ops (removeRoot / reveal). Cleared
  // when a new op starts or the user dismisses it — a failed op no longer
  // swallows its error result silently.
  const [opError, setOpError] = useState<string | null>(null);
  // #1493 — transient info surface: removeRoot may also prune orphaned
  // path-scoped grants under the removed root. When it does, tell the user so
  // the extra revocation isn't silent. Cleared on the next op or on dismiss.
  const [opInfo, setOpInfo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const res = await window.lvis.workspace.listDir(path);
      if (res.ok && res.entries) {
        setChildrenByPath((prev) => ({ ...prev, [path]: res.entries ?? [] }));
        setTruncatedPaths((prev) => {
          const has = prev.has(path);
          if (res.truncated && !has) return new Set(prev).add(path);
          if (!res.truncated && has) {
            const next = new Set(prev);
            next.delete(path);
            return next;
          }
          return prev;
        });
        setErrorByPath((prev) => {
          if (!(path in prev)) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
      } else {
        // Surface the failure rather than swallowing it silently.
        setErrorByPath((prev) => ({ ...prev, [path]: res.error ?? "read-failed" }));
      }
    } catch {
      setErrorByPath((prev) => ({ ...prev, [path]: "read-failed" }));
    } finally {
      setAttemptedPaths((prev) => new Set(prev).add(path));
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const applyRoots = useCallback(
    (next: Array<{ path: string; isDefault: boolean }>, preferred?: string | null) => {
      setRoots(next);
      setActiveRoot((prev) => {
        const keep = preferred ?? prev;
        if (keep && next.some((r) => r.path === keep)) return keep;
        return next[0]?.path ?? null;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void window.lvis.workspace.listRoots().then((res) => {
      if (cancelled || !res.ok || !res.roots) return;
      applyRoots(res.roots);
    });
    return () => {
      cancelled = true;
    };
  }, [applyRoots]);

  useEffect(() => {
    if (
      activeRoot &&
      !childrenByPath[activeRoot] &&
      !loadingPaths.has(activeRoot) &&
      !attemptedPaths.has(activeRoot)
    ) {
      void loadDir(activeRoot);
    }
  }, [activeRoot, childrenByPath, loadingPaths, attemptedPaths, loadDir]);

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Manual expand is a user gesture (not a render loop): allow a retry of a
        // previously-failed folder by clearing its attempted mark before loading.
        if (!childrenByPath[path] && !loadingPaths.has(path)) {
          setAttemptedPaths((prevAttempted) => {
            if (!prevAttempted.has(path)) return prevAttempted;
            const nextAttempted = new Set(prevAttempted);
            nextAttempted.delete(path);
            return nextAttempted;
          });
          void loadDir(path);
        }
      }
      return next;
    });
  };

  // Flattened pre-order list of the CURRENTLY VISIBLE nodes (expanded subtrees
  // only). Rendering stays recursive; this memo backs keyboard navigation only.
  const flatNodes = useMemo<
    Array<{ path: string; name: string; isDir: boolean; depth: number; parentPath: string }>
  >(() => {
    if (!activeRoot) return [];
    const out: Array<{ path: string; name: string; isDir: boolean; depth: number; parentPath: string }> = [];
    const walk = (parentPath: string, depth: number) => {
      const siblings = childrenByPath[parentPath] ?? [];
      for (const entry of siblings) {
        const isDir = entry.type === "directory";
        out.push({ path: entry.path, name: entry.name, isDir, depth, parentPath });
        if (isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(activeRoot, 0);
    return out;
  }, [activeRoot, childrenByPath, expanded]);

  // Clamp the roving pointer when the tree changes (collapse / reload / switch).
  useEffect(() => {
    if (flatNodes.length === 0) {
      if (activeItemPath !== null) setActiveItemPath(null);
      return;
    }
    if (!activeItemPath || !flatNodes.some((n) => n.path === activeItemPath)) {
      setActiveItemPath(flatNodes[0].path);
    }
  }, [flatNodes, activeItemPath]);

  // Move DOM focus only for keyboard-driven changes (roving tabindex).
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    if (activeItemPath) itemRefs.current.get(activeItemPath)?.focus();
  }, [activeItemPath]);

  // Clear the type-ahead timer on unmount.
  useEffect(
    () => () => {
      if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
    },
    [],
  );

  const focusPath = useCallback((path: string | null) => {
    if (!path) return;
    pendingFocusRef.current = true;
    setActiveItemPath(path);
  }, []);

  const runTypeahead = (char: string, curIdx: number) => {
    const ta = typeaheadRef.current;
    if (ta.timer) clearTimeout(ta.timer);
    ta.buffer += char.toLowerCase();
    ta.timer = setTimeout(() => {
      ta.buffer = "";
      ta.timer = null;
    }, 500);
    const n = flatNodes.length;
    // Single-char buffer starts the search at the NEXT node (cycles repeats);
    // multi-char refines from the current node.
    const startOffset = ta.buffer.length === 1 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const cand = flatNodes[(curIdx + startOffset + i) % n];
      if (cand.name.toLowerCase().startsWith(ta.buffer)) {
        focusPath(cand.path);
        return;
      }
    }
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent) => {
    if (flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.path === activeItemPath);
    const i = idx >= 0 ? idx : 0;
    const cur = flatNodes[i];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusPath(flatNodes[Math.min(i + 1, flatNodes.length - 1)].path);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusPath(flatNodes[Math.max(i - 1, 0)].path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur.isDir) {
          if (!expanded.has(cur.path)) {
            toggleFolder(cur.path); // collapsed -> expand (also lazy-loads)
          } else {
            const child = flatNodes[i + 1]; // expanded -> first child (if loaded)
            if (child && child.parentPath === cur.path) focusPath(child.path);
          }
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur.isDir && expanded.has(cur.path)) {
          toggleFolder(cur.path); // expanded -> collapse
        } else if (cur.parentPath !== activeRoot) {
          focusPath(cur.parentPath); // else -> parent (activeRoot isn't a treeitem)
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur.isDir) toggleFolder(cur.path);
        else onOpenFile(cur.path);
        break;
      case "Home":
        e.preventDefault();
        focusPath(flatNodes[0].path);
        break;
      case "End":
        e.preventDefault();
        focusPath(flatNodes[flatNodes.length - 1].path);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          runTypeahead(e.key, i);
        }
    }
  };

  const addFolder = useCallback(async () => {
    const result = await pickProjectFolder();
    if (result) applyRoots(result.roots, result.added);
  }, [applyRoots, pickProjectFolder]);

  // ⌘O / Ctrl+O opens the folder picker when focus is within the panel (scoped —
  // no global shortcut pollution).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "o" || e.key === "O")) {
        const root = rootRef.current;
        if (root && root.contains(document.activeElement)) {
          e.preventDefault();
          void addFolder();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addFolder]);

  // Surface a mutating-op IPC failure inline. `path-not-allowed` / `sensitive-path`
  // are the workspace-specific reveal codes absent from the shared IPC map, so
  // map them to the same "outside allowed folders" copy the file preview uses.
  const formatOpError = useCallback(
    (error: string | undefined, message: string | undefined) =>
      formatIpcError(error, message, {
        codeMap: {
          "path-not-allowed": t("chatPreviewRail.fileErrorNotAllowed"),
          "sensitive-path": t("chatPreviewRail.fileErrorNotAllowed"),
        },
      }),
    [t],
  );

  // Drag-drop add-root (#1458). A dropped folder path is renderer-NAMED — the
  // preload webUtils bridge turns the dropped File into a candidate path, which
  // main-side dropPrepare re-validates (Layer-0 hard-deny + is-a-directory)
  // before minting a MAIN-OWNED ack token. A drop ALWAYS routes through the same
  // acknowledgement panel the native warned-pick uses (the OS dialog never
  // vouched for the path, so the explicit user ack is that missing vouch), and
  // confirmPendingFolder echoes the token — never the path — to pickRoot. So the
  // drop can never widen the read scope without the user confirming.
  const handleFolderDrop = useCallback(
    async (files: FileList) => {
      setOpError(null);
      const paths = window.lvisDrop.resolveDroppedPaths(files);
      const dropped = paths[0]; // first dropped item only — no multi-add fan-out
      if (!dropped) return; // non-file drag (text/url) or unresolvable — no-op
      const res = await window.lvis.workspace.dropPrepare(dropped);
      if (!res.ok) {
        setOpError(formatOpError(res.error, undefined));
        return;
      }
      if (res.pendingPath && res.ackToken) {
        setPendingWarning({
          path: res.pendingPath,
          warnings: res.warnings ?? [],
          ackToken: res.ackToken,
        });
      }
    },
    [formatOpError],
  );

  // Reveal a file/folder in the OS file manager. Re-validated in main; surfaces
  // any failure inline instead of swallowing the result.
  const revealEntry = async (path: string) => {
    setOpError(null);
    const res = await window.lvis.workspace.reveal(path);
    if (!res.ok) setOpError(formatOpError(res.error, res.message));
  };

  const confirmPendingFolder = async () => {
    const result = await confirmPendingFolderShared();
    if (result) applyRoots(result.roots, result.added);
  };

  const activeRootIsDefault = Boolean(
    activeRoot && roots.find((r) => r.path === activeRoot)?.isDefault,
  );

  // Remove the active root from the read allow-list. Non-destructive (files are
  // untouched — only the Layer-1 read scope narrows); main refuses to remove the
  // default root or any path not already in `additionalDirectories`.
  const removeActiveRoot = async () => {
    if (!activeRoot || activeRootIsDefault) return;
    const removedRoot = activeRoot;
    setOpError(null);
    setOpInfo(null);
    const res = await window.lvis.workspace.removeRoot(removedRoot);
    if (!res.ok) {
      setOpError(formatOpError(res.error, res.message));
      return;
    }
    // Surface the extra revocation when path-scoped grants under the removed
    // root were pruned, so the widened effect of "Remove folder" is visible.
    if (res.prunedGrants && res.prunedGrants > 0) {
      setOpInfo(t("chatPreviewRail.removeRootPruned", { count: res.prunedGrants }));
    }
    if (!res.roots) return;
    // Drop cached children/expansion for the removed subtree so a re-add reloads.
    // Boundary-safe + cross-platform: `isPathWithinRoot` matches on a full
    // segment (so `/foo` won't purge `/foobar`) and both `/` and `\` separators.
    setChildrenByPath((prev) => {
      const next: Record<string, WorkspaceDirEntry[]> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (isPathWithinRoot(removedRoot, key)) continue;
        next[key] = value;
      }
      return next;
    });
    applyRoots(res.roots, res.roots[0]?.path ?? null);
  };

  // Re-list a folder whose previous listDir FAILED. A user gesture, so it clears
  // the attempted mark (the render-loop guard) before reloading.
  const retryDir = (path: string) => {
    setAttemptedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setErrorByPath((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    void loadDir(path);
  };

  const renderEntries = (path: string, depth: number): ReactElement => {
    const entries = childrenByPath[path] ?? [];
    const childPad = 8 + depth * 12;
    // Child-folder listing states (the active root's own loading/error is handled
    // one level up so the role=tree wrapper is always present).
    if (depth > 0 && loadingPaths.has(path) && entries.length === 0) {
      return (
        <div
          role="presentation"
          className="flex h-7 items-center gap-1 text-[11px] text-muted-foreground"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-child-loading"
        >
          {t("chatPreviewRail.filePreviewLoading")}
        </div>
      );
    }
    if (depth > 0 && errorByPath[path]) {
      return (
        <button
          type="button"
          className="flex h-7 w-full items-center gap-1 text-left text-[11px] text-destructive hover:underline"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-child-error"
          onClick={() => retryDir(path)}
        >
          {t("chatPreviewRail.dirLoadError")} · {t("common.retry")}
        </button>
      );
    }
    if (entries.length === 0 && attemptedPaths.has(path) && !loadingPaths.has(path) && !errorByPath[path]) {
      return (
        <div
          role="presentation"
          className="flex h-7 items-center text-[11px] italic text-muted-foreground"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-empty"
        >
          {t("chatPreviewRail.dirEmpty")}
        </div>
      );
    }
    return (
    <>
      {entries.map((entry, index) => {
        const isDir = entry.type === "directory";
        const isOpen = expanded.has(entry.path);
        const opened = !isDir && entry.path === selectedPath;
        const isActiveItem = entry.path === activeItemPath;
        return (
          <div key={entry.path}>
                <div
                  ref={(el) => {
                    if (el) itemRefs.current.set(entry.path, el);
                    else itemRefs.current.delete(entry.path);
                  }}
                  role="treeitem"
                  aria-expanded={isDir ? isOpen : undefined}
                  // APG tree pattern: aria-selected reflects SELECTION (the
                  // opened file), not roving keyboard focus. Focus is carried
                  // separately by the roving tabindex below, so a screen reader
                  // announces the opened file — not merely the arrow-key cursor
                  // position — as "selected". Non-opened rows omit the attribute.
                  aria-selected={opened ? true : undefined}
                  aria-level={depth + 1}
                  aria-setsize={entries.length}
                  aria-posinset={index + 1}
                  tabIndex={isActiveItem ? 0 : -1}
                  data-testid={isDir ? "chat-side-panel-fs-folder" : "chat-side-panel-fs-file"}
                  className={`flex h-7 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md pr-2 text-left text-xs outline-none hover:bg-muted/(--opacity-muted) focus-visible:ring-1 focus-visible:ring-ring ${
                    opened ? "bg-accent text-accent-foreground" : ""
                  }`}
                  style={{ paddingLeft: 8 + depth * 12 }}
                  onClick={() => {
                    setActiveItemPath(entry.path);
                    if (isDir) toggleFolder(entry.path);
                    else onOpenFile(entry.path);
                  }}
                  onContextMenu={(event) => openNativeContextMenu(event, "workspace-entry", {
                    "workspace.open": () => (
                      isDir ? toggleFolder(entry.path) : onOpenFile(entry.path)
                    ),
                    "workspace.reveal": () => void revealEntry(entry.path),
                    "workspace.copy-path": () =>
                      void navigator.clipboard?.writeText(entry.path),
                    "workspace.copy-relative-path": () =>
                      void navigator.clipboard?.writeText(
                        toRelativePath(activeRoot, entry.path),
                      ),
                  })}
                >
                  {isDir ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    createElement(fileIcon(entry.name), {
                      className: "h-3.5 w-3.5 shrink-0 text-muted-foreground",
                    })
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </div>
            {isDir && isOpen ? <div role="group">{renderEntries(entry.path, depth + 1)}</div> : null}
          </div>
        );
      })}
      {truncatedPaths.has(path) ? (
        <div
          role="presentation"
          className="flex h-6 items-center text-[11px] italic text-muted-foreground"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-truncated"
        >
          {t("chatPreviewRail.dirTruncated")}
        </div>
      ) : null}
    </>
    );
  };

  return (
    // Drag-drop add-root (#1458): a dropped folder resolves to a renderer-named
    // candidate path (preload webUtils bridge) that main-side dropPrepare
    // hard-validates before an explicit ack — so it rides the #1448 ack tier
    // rather than regressing it. Add-root also stays on the native picker (the
    // FolderPlus button + ⌘/Ctrl+O), which the drop convenience sits on top of.
    <div
      ref={rootRef}
      className={cn(
        "space-y-1 rounded-md transition-colors",
        dragOver && "ring-2 ring-primary/(--opacity-half) bg-primary/(--opacity-faint)",
      )}
      data-testid="chat-side-panel-project-roots"
      onDragOver={(event) => {
        // preventDefault is required or the browser navigates to the file.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(event) => {
        // Ignore leave events bubbling from children still inside the panel.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void handleFolderDrop(event.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-1">
        {roots.length > 1 ? (
          <select
            aria-label={t("chatPreviewRail.rootSelectLabel")}
            data-testid="chat-side-panel-root-select"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs"
            value={activeRoot ?? ""}
            onChange={(event) => setActiveRoot(event.target.value)}
          >
            {roots.map((root) => (
              <option key={root.path} value={root.path}>
                {fileBasename(root.path)}
                {root.isDefault ? ` · ${t("chatPreviewRail.rootDefaultBadge")}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
            {activeRoot ? fileBasename(activeRoot) : t("chatPreviewRail.projectRoots")}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-add-root"
              aria-label={t("chatPreviewRail.addProjectRoot")}
              onClick={() => void addFolder()}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.addProjectRoot")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-collapse-all"
              aria-label={t("chatPreviewRail.collapseAll")}
              disabled={expanded.size === 0}
              onClick={() => setExpanded(new Set())}
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.collapseAll")}</TooltipContent>
        </Tooltip>
        {activeRoot && !activeRootIsDefault ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                data-testid="chat-side-panel-remove-root"
                aria-label={t("chatPreviewRail.removeRoot")}
                onClick={() => void removeActiveRoot()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("chatPreviewRail.removeRoot")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {opError ? (
        <div
          role="alert"
          data-testid="chat-side-panel-op-error"
          className="flex items-start gap-1 rounded-md border border-destructive bg-destructive/(--opacity-muted) px-2 py-1 text-[11px] text-destructive"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{opError}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-destructive/(--opacity-muted)"
            aria-label={t("common.close")}
            data-testid="chat-side-panel-op-error-dismiss"
            onClick={() => setOpError(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {opInfo ? (
        <div
          role="status"
          data-testid="chat-side-panel-op-info"
          className="flex items-start gap-1 rounded-md border bg-muted/(--opacity-muted) px-2 py-1 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{opInfo}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            aria-label={t("common.close")}
            data-testid="chat-side-panel-op-info-dismiss"
            onClick={() => setOpInfo(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {pendingWarning ? (
        <div
          data-testid="chat-side-panel-root-warning"
          className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-[11px]"
        >
          <div className="font-medium text-destructive">{t("chatPreviewRail.rootWarningTitle")}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
            {pendingWarning.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid="chat-side-panel-root-warning-confirm"
              onClick={() => void confirmPendingFolder()}
            >
              {t("chatPreviewRail.rootWarningConfirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="chat-side-panel-root-warning-cancel"
              onClick={cancelPendingFolder}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {activeRoot ? (
        loadingPaths.has(activeRoot) && !childrenByPath[activeRoot] ? (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">{t("chatPreviewRail.filePreviewLoading")}</div>
        ) : errorByPath[activeRoot] ? (
          <button
            type="button"
            className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-destructive hover:underline"
            data-testid="chat-side-panel-fs-error"
            onClick={() => retryDir(activeRoot)}
          >
            {t("chatPreviewRail.dirLoadError")} · {t("common.retry")}
          </button>
        ) : (
          <div role="tree" aria-label={t("chatPreviewRail.projectRoots")} onKeyDown={onTreeKeyDown}>
            {renderEntries(activeRoot, 0)}
          </div>
        )
      ) : (
        <div
          className="flex flex-col items-start gap-2 px-2 py-3 text-[11px] text-muted-foreground"
          data-testid="chat-side-panel-roots-empty"
        >
          <p>{t("chatPreviewRail.projectRootsEmpty")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void addFolder()}>
            <FolderPlus className="h-3.5 w-3.5" />
            {t("chatPreviewRail.addProjectRoot")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function FileBrowserWorkspace({
  api,
  sessionId,
  files,
  targetById,
  selectedId,
  onSelect,
}: {
  api: LvisApi;
  sessionId?: string;
  files: WorkspaceFileItem[];
  targetById: Map<string, ChatPreviewTarget>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { topPercent, setTopPercent, commitTopPercent } = useVerticalSplit(api, "sidePanelSplitFilePercent");
  // A concrete filesystem file opened from the project-roots browser. Takes
  // precedence over the session-artifact selection in the detail pane.
  const [fsPath, setFsPath] = useState<string | null>(null);
  // Which source the TOP pane shows (R3): the project directory tree or this
  // chat's session artifacts. A segment toggle replaces the old vertical
  // stacking that squeezed the session list into a sliver. This is a SOURCE
  // switch on the horizontal axis — orthogonal to the top/bottom split axis
  // above, so the two never fight.
  const [fileSource, setFileSource] = useState<"directory" | "session">("directory");
  const sessionFileCount = files.length;
  const hasSessionFiles = sessionFileCount > 0;
  // The session segment is disabled with zero files; snap back to directory so a
  // previously-selected-but-now-empty session source can't strand an empty pane.
  const effectiveSource = fileSource === "session" && hasSessionFiles ? "session" : "directory";
  const tree = useMemo(() => filterFileTree(buildFileTree(files), query), [files, query]);
  const filteredFiles = useMemo(
    () => files.filter((file) => matchesQuery(query, file.label, file.detail, file.path, file.sourceLabel)),
    [files, query],
  );
  const selectedFile = useMemo(
    () => filteredFiles.find((file) => file.previewTargetId === selectedId) ?? filteredFiles[0] ?? null,
    [filteredFiles, selectedId],
  );
  const selectedFileTarget = selectedFile?.previewTargetId ? targetById.get(selectedFile.previewTargetId) ?? null : null;
  const hasFiles = filteredFiles.length > 0;
  const fsTarget = useMemo<Extract<ChatPreviewTarget, { kind: "file" }> | null>(() => {
    if (!fsPath) return null;
    return {
      id: `fs:${fsPath}`,
      kind: "file",
      title: fileBasename(fsPath),
      sourceLabel: "workspace",
      createdOrder: Number.MAX_SAFE_INTEGER,
      path: fsPath,
      // Not in the attach allow-list, so the OS "open" button would be denied —
      // keep it off; content still loads through the preview IPC.
      canOpenExternal: false,
    };
  }, [fsPath]);

  useEffect(() => {
    if (selectedFile?.previewTargetId && selectedFile.previewTargetId !== selectedId) {
      onSelect(selectedFile.previewTargetId);
    }
  }, [onSelect, selectedFile, selectedId]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-file-browser">
      {/*
        The search box filters ONLY the session-artifact list (filteredFiles /
        tree); the Directory source (ProjectRootsBrowser) has no query wiring, so
        showing it there is a dead affordance. Render it only for the Session
        segment so there is no no-op search control.
      */}
      {effectiveSource === "session" ? (
        <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
      ) : null}
      <VerticalSplitLayout
        topPercent={topPercent}
        onDragChange={setTopPercent}
        onCommit={commitTopPercent}
        ariaLabel={t("chatPreviewRail.resizeFilePanels")}
        testId="chat-side-panel-file-split-layout"
        separatorTestId="chat-side-panel-file-splitter"
        top={
          <div className="flex min-h-0 flex-col" data-testid="chat-side-panel-file-tree">
            {/*
              R3 segment toggle: pick the top pane's source (project directory
              vs session artifacts) instead of stacking both. Only the chosen
              source occupies the whole pane, so the session list is no longer
              squeezed. The session segment is disabled when the chat has no
              artifacts yet.
            */}
            <div
              role="group"
              aria-label={t("chatPreviewRail.fileSourceLabel")}
              className="flex shrink-0 items-center gap-1 border-b px-1 py-0.5"
              data-testid="chat-side-panel-file-source-segment"
            >
              <button
                type="button"
                aria-pressed={effectiveSource === "directory"}
                data-testid="chat-side-panel-file-source-directory"
                className={cn(
                  "flex h-6 flex-1 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium",
                  effectiveSource === "directory"
                    ? "bg-primary/(--opacity-subtle) text-primary"
                    : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground",
                )}
                onClick={() => setFileSource("directory")}
              >
                <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                {t("chatPreviewRail.fileSourceDirectory")}
              </button>
              <button
                type="button"
                aria-pressed={effectiveSource === "session"}
                disabled={!hasSessionFiles}
                data-testid="chat-side-panel-file-source-session"
                className={cn(
                  "flex h-6 flex-1 items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-(--opacity-half)",
                  effectiveSource === "session"
                    ? "bg-primary/(--opacity-subtle) text-primary"
                    : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground",
                )}
                onClick={() => setFileSource("session")}
              >
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                {t("chatPreviewRail.fileSourceSession")}
                <Badge variant="outline" className="px-1 py-0 text-[10px]" data-testid="chat-side-panel-file-source-session-count">
                  {sessionFileCount}
                </Badge>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {effectiveSource === "directory" ? (
                <ProjectRootsBrowser
                  selectedPath={fsPath}
                  onOpenFile={(path) => {
                    setFsPath(path);
                  }}
                />
              ) : hasFiles && tree.length > 0 ? (
                <FileTreeRows
                  nodes={tree}
                  selectedFileId={fsPath ? undefined : selectedFile?.id}
                  onSelectFile={(file) => {
                    setFsPath(null);
                    if (file.previewTargetId) onSelect(file.previewTargetId);
                  }}
                />
              ) : (
                <EmptyState>{t("chatPreviewRail.noFiles")}</EmptyState>
              )}
            </div>
          </div>
        }
        bottom={
          <div className="min-h-0 p-3">
            {fsTarget ? (
              <div className="space-y-3">
                <DetailHeader target={fsTarget} />
                <PreviewBody api={api} sessionId={sessionId} target={fsTarget} />
              </div>
            ) : selectedFileTarget ? (
              <div className="space-y-3">
                <DetailHeader target={selectedFileTarget} />
                <PreviewBody api={api} sessionId={sessionId} target={selectedFileTarget} />
              </div>
            ) : selectedFile ? (
              <div className="space-y-3">
                <div className="flex min-w-0 items-center gap-2">
                  <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{selectedFile.label}</h3>
                </div>
                <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
                  {selectedFile.path}
                </div>
                <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.pathOnlyHint")}</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{t("chatPreviewRail.emptyState")}</div>
            )}
          </div>
        }
      />
    </div>
  );
}

export function PreviewWorkspace({
  api,
  sessionId,
  targets,
  selectedId,
  onSelect,
}: {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.toolName)),
    [targets, query],
  );
  const selectedTarget = useMemo(
    () => filteredTargets.find((target) => target.id === selectedId) ?? filteredTargets[0] ?? null,
    [filteredTargets, selectedId],
  );

  useEffect(() => {
    if (selectedTarget && selectedTarget.id !== selectedId) onSelect(selectedTarget.id);
  }, [onSelect, selectedId, selectedTarget]);

  return (
    <ListDetailWorkspace
      api={api}
      sessionId={sessionId}
      query={query}
      setQuery={setQuery}
      placeholder={t("chatPreviewRail.searchPlaceholder")}
      rows={filteredTargets}
      selectedTarget={selectedTarget}
      emptyText={t("chatPreviewRail.noPreviewTargets")}
      rowTestId="chat-preview-target-row"
      onSelect={onSelect}
    />
  );
}

export function BrowserWorkspace({
  api,
  tabId,
  targets,
  selectedId,
  onSelect,
  manualUrl,
  onManualUrlChange,
}: {
  api: LvisApi;
  tabId: string;
  targets: ChatPreviewTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  manualUrl: string | null;
  onManualUrlChange: (tabId: string, url: string | null) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [addressDraft, setAddressDraft] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.kind === "url" ? target.url : undefined)),
    [targets, query],
  );
  const selectedTarget = useMemo(
    () => filteredTargets.find((target) => target.id === selectedId) ?? filteredTargets[0] ?? null,
    [filteredTargets, selectedId],
  );

  useEffect(() => {
    if (selectedTarget && selectedTarget.id !== selectedId) onSelect(selectedTarget.id);
  }, [onSelect, selectedId, selectedTarget]);

  useEffect(() => {
    setAddressDraft(manualUrl ?? (selectedTarget?.kind === "url" ? selectedTarget.url : ""));
    setAddressError(null);
  }, [manualUrl, selectedTarget, tabId]);

  const manualTarget = useMemo<Extract<ChatPreviewTarget, { kind: "url" }> | null>(() => {
    if (!manualUrl) return null;
    let title: string;
    try {
      title = new URL(manualUrl).hostname || manualUrl;
    } catch {
      title = manualUrl;
    }
    return {
      id: `manual-browser:${tabId}`,
      kind: "url",
      title,
      subtitle: t("chatPreviewRail.manualUrlSubtitle"),
      sourceLabel: t("chatPreviewRail.manualUrlSource"),
      createdOrder: Number.MAX_SAFE_INTEGER,
      url: manualUrl,
    };
  }, [manualUrl, t, tabId]);
  const displayedTarget = manualTarget ?? selectedTarget;

  const submitAddress = () => {
    const normalized = normalizeBrowserNavigationUrl(addressDraft);
    if (!normalized) {
      setAddressError(t("chatPreviewRail.browserInvalidUrl"));
      return;
    }
    setAddressDraft(normalized);
    setAddressError(null);
    onManualUrlChange(tabId, normalized);
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-browser-workspace">
      {/*
        Single address bar (#11): the browser tab owns ONE address row here and
        the viewer's own header is suppressed (UrlDocumentViewer showHeader=false)
        so there is no duplicate URL band nesting. The web-artifact list + search
        moved out of the always-on stacked strip into the floating 🔍 Popover.
      */}
      <form
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress();
        }}
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          data-testid="chat-side-panel-browser-address"
          value={addressDraft}
          onChange={(event) => {
            setAddressDraft(event.target.value);
            if (addressError) setAddressError(null);
          }}
          placeholder={t("chatPreviewRail.browserAddressPlaceholder")}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Popover open={searchOpen} onOpenChange={setSearchOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  // Radix sets data-state=open on the trigger while the search
                  // Popover is open; reflect that with an active tint so the
                  // toggled state is visible (R2).
                  className="h-8 w-8 shrink-0 data-[state=open]:bg-primary/(--opacity-subtle) data-[state=open]:text-primary"
                  aria-label={t("chatPreviewRail.browserSearch")}
                  data-testid="chat-side-panel-browser-search-trigger"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("chatPreviewRail.browserSearch")}</TooltipContent>
          </Tooltip>
          <PopoverContent
            align="end"
            className="w-72 p-0"
            data-testid="chat-side-panel-browser-search-popover"
          >
            <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
            <div className="max-h-64 overflow-auto p-2">
              {filteredTargets.length > 0 ? (
                <TargetRows
                  targets={filteredTargets}
                  selectedId={manualTarget ? undefined : selectedTarget?.id}
                  rowTestId="chat-side-panel-browser-row"
                  onSelect={(id) => {
                    onManualUrlChange(tabId, null);
                    onSelect(id);
                    setSearchOpen(false);
                  }}
                />
              ) : (
                <EmptyState>{t("chatPreviewRail.noBrowserTargets")}</EmptyState>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              aria-label={t("chatPreviewRail.browserGo")}
              data-testid="chat-side-panel-browser-go"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chatPreviewRail.browserGo")}</TooltipContent>
        </Tooltip>
      </form>
      {addressError ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-destructive" data-testid="chat-side-panel-browser-address-error">
          {addressError}
        </div>
      ) : null}
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {displayedTarget?.kind === "html" ? (
          <BrowserDocumentViewer target={displayedTarget} />
        ) : displayedTarget?.kind === "url" ? (
          <UrlDocumentViewer api={api} target={displayedTarget} showHeader={false} />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">{t("chatPreviewRail.noBrowserTargets")}</div>
        )}
      </div>
    </div>
  );
}
