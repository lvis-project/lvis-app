import { useState } from "react";
import { File as FileIcon, ClipboardPaste } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover.js";
import {
  ATTACH_MAX_COUNT,
  type Attachment,
} from "../types/attachments.js";
import { collapsePath } from "../utils/attachment-markers.js";
import { useTranslation } from "../../../i18n/react.js";

const THUMB_MAX_PX = 48;

/**
 * Color ramp for the stacked-card visual. Each successive attachment adds a
 * new colored card behind the icon-bearing top layer, so 2-vs-5 attachments
 * are visually distinct (denser stack = more cards).
 */
const STACK_COLORS = [
  "from-sky-300 to-sky-700",
  "from-emerald-300 to-emerald-700",
  "from-amber-300 to-amber-600",
  "from-violet-300 to-violet-700",
  "from-rose-300 to-rose-700",
];

const STACK_OFFSET_PX = 2;

function ImageThumb({ att }: { att: Extract<Attachment, { kind: "image" }> }) {
  const longest = Math.max(att.width, att.height) || 1;
  const w = Math.round((att.width / longest) * THUMB_MAX_PX);
  const h = Math.round((att.height / longest) * THUMB_MAX_PX);
  return (
    <img
      src={att.dataUrl}
      alt={`Image #${att.n}`}
      width={w}
      height={h}
      style={{ width: w, height: h, objectFit: "contain" }}
      className="rounded border border-border bg-muted"
    />
  );
}

function FileThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <FileIcon className="h-5 w-5" />
    </div>
  );
}

function PasteThumb() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) text-warning">
      <ClipboardPaste className="h-5 w-5" />
    </div>
  );
}

function chipLabel(att: Attachment): string {
  if (att.kind === "image") return `#${att.n}`;
  if (att.kind === "file") return collapsePath(att.name);
  return `+${att.lines} lines`;
}

function badgeClass(count: number): string {
  if (count >= ATTACH_MAX_COUNT) return "text-destructive font-bold";
  if (count >= ATTACH_MAX_COUNT - 1) return "text-warning font-semibold";
  return "text-muted-foreground";
}

/**
 * Stacked-card visual. Renders `layers` cards (capped to ATTACH_MAX_COUNT),
 * each offset diagonally so density increases with attachment count. The
 * top card carries an icon; the others are bare colored cards behind it.
 */
function StackVisual({ layers }: { layers: number }) {
  const n = Math.max(2, Math.min(layers, ATTACH_MAX_COUNT));
  const cards = Array.from({ length: n }, (_, i) => i);
  return (
    <div className="relative h-12 w-12" data-testid="chip-stack" data-layers={n}>
      {cards.map((i) => {
        const isTop = i === n - 1;
        const left = i * STACK_OFFSET_PX;
        const top = (n - 1 - i) * STACK_OFFSET_PX;
        if (isTop) {
          return (
            <div
              key={i}
              style={{ left, top, width: 40, height: 40 }}
              className="absolute flex items-center justify-center rounded-md border border-background bg-muted text-muted-foreground shadow"
            >
              <FileIcon className="h-4 w-4" />
            </div>
          );
        }
        return (
          <div
            key={i}
            style={{ left, top, width: 40, height: 40 }}
            className={`absolute rounded-md border border-background bg-gradient-to-br ${STACK_COLORS[i % STACK_COLORS.length]} shadow`}
          />
        );
      })}
    </div>
  );
}

/**
 * Single chip — used when there is exactly one attachment. The whole chip
 * is a popover trigger so the user can inspect the file path and open the
 * file in the OS's default app, matching the multi-attachment overlay UX.
 *
 * No close button: the textarea body is the source of truth, so removal
 * happens by deleting the `[…#N]` marker from the body text.
 */
export function AttachmentChip({
  attachment,
  total,
  onOpenExternal,
}: {
  attachment: Attachment;
  total: number;
  onOpenExternal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="attachment-chip"
          aria-label={t("attachmentChip.chipAriaLabel", { label: chipLabel(attachment) })}
          className="flex max-w-20 flex-col items-center gap-1 rounded-sm select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={t("attachmentChip.chipTitle")}
        >
          {attachment.kind === "image" ? (
            <ImageThumb att={attachment} />
          ) : attachment.kind === "file" ? (
            <FileThumb />
          ) : (
            <PasteThumb />
          )}
          <span
            className={`max-w-full truncate text-[10px] font-mono ${badgeClass(total)}`}
            data-testid="chip-count-badge"
            title={`${chipLabel(attachment)} · ${total}/${ATTACH_MAX_COUNT}`}
          >
            {chipLabel(attachment)} · {total}/{ATTACH_MAX_COUNT}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="attachment-overlay"
        className="w-[380px] p-2"
      >
        <AttachmentOverlay
          attachments={[attachment]}
          onOpenExternal={onOpenExternal}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Stacked-card chip — used when there are 2+ attachments. The visible layer
 * count scales 1:1 with attachments.length (capped at ATTACH_MAX_COUNT) so
 * 2-vs-5 attachments are visually distinct. Click opens the same overlay as
 * the single-chip variant.
 */
export function AttachmentChipCollapsed({
  attachments,
  onOpenExternal,
}: {
  attachments: Attachment[];
  onOpenExternal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const total = attachments.length;
  const isFull = total >= ATTACH_MAX_COUNT;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="attachment-chip-collapsed"
          aria-label={t("attachmentChip.collapsedAriaLabel", { total })}
          className="flex max-w-20 flex-col items-center gap-1 rounded-sm select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={t("attachmentChip.collapsedTitle")}
        >
          <StackVisual layers={total} />
          <span
            className={`max-w-full truncate text-[10px] font-mono ${badgeClass(total)}`}
            data-testid="chip-count-badge"
          >
            {total}/{ATTACH_MAX_COUNT}
            {isFull ? " full" : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        data-testid="attachment-overlay"
        className="w-[380px] p-2"
      >
        <AttachmentOverlay
          attachments={attachments}
          onOpenExternal={onOpenExternal}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Overlay body — listed by attachment N, each row shows thumbnail + name +
 * collapsed path + meta. The "open externally" action delegates to the host
 * via window.lvis.attach.openExternal (passed in as callback).
 *
 * No remove buttons: removal is exclusively via deleting the marker text.
 */
export function AttachmentOverlay({
  attachments,
  onOpenExternal,
}: {
  attachments: Attachment[];
  onOpenExternal?: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="attachment-overlay-body">
      <div className="mb-2 flex items-center justify-between border-b border-border pb-1.5">
        <span className="text-xs font-semibold text-muted-foreground">
          {t("attachmentChip.overlayCount", { count: attachments.length })}
        </span>
        <span className="text-[10px] text-muted-foreground/(--opacity-stronger)">
          {t("attachmentChip.overlayRemoveHint")}
        </span>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto">
        {attachments.map((att) => (
          <div
            key={att.id}
            data-testid="overlay-item"
            className="flex items-center gap-3 border-b border-muted/(--opacity-medium) py-2 last:border-b-0"
          >
            <div className="flex-shrink-0">
              {att.kind === "image" ? (
                <img
                  src={att.dataUrl}
                  alt={`Image #${att.n}`}
                  className="h-9 w-9 rounded object-contain"
                />
              ) : att.kind === "file" ? (
                <FileThumb />
              ) : (
                <PasteThumb />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">
                {att.kind === "image"
                  ? `Image #${att.n}`
                  : att.kind === "file"
                    ? `File #${att.n}`
                    : `Pasted text #${att.n}`}
              </div>
              <div
                className="truncate font-mono text-[10px] text-muted-foreground"
                title={att.kind === "paste" ? undefined : att.path}
              >
                {att.kind === "image"
                  ? collapsePath(att.path)
                  : att.kind === "file"
                    ? collapsePath(att.path)
                    : `+${att.lines} lines · ${att.chars} chars`}
              </div>
              <div className="text-[10px] text-muted-foreground/(--opacity-stronger)">
                {att.kind === "image"
                  ? `${att.mimeType} · ${att.width}×${att.height} · ${formatBytes(att.bytes)}`
                  : att.kind === "file"
                    ? `${att.ext.toUpperCase()} · ${formatBytes(att.bytes)}`
                    : t("attachmentChip.pastedFromClipboard")}
              </div>
            </div>
            {att.kind !== "paste" && onOpenExternal ? (
              <button
                type="button"
                onClick={() => onOpenExternal(att.path)}
                className="flex-shrink-0 rounded border border-border px-2 py-1 text-[10px] hover:bg-muted"
                title={t("attachmentChip.openExternalTitle")}
              >
                ↗ {t("attachmentChip.openExternalButton")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
