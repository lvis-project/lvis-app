/**
 * DevComponentLabels — names the regions on screen, in dev builds only.
 *
 * When a person points at part of the window and says "this", and the reply
 * names a component, the two can mean different things and nothing in the
 * conversation reveals it until a change lands on the wrong element. What
 * closes that gap is a shared vocabulary that is VISIBLE: the `data-testid`
 * already on the element, drawn where the element is.
 *
 * Two granularities, because "this" means both:
 *   - REGIONS are labelled persistently. A region is a testid whose box is at
 *     least {@link MIN_REGION} — panels, canvases, tiles — which is the size at
 *     which someone points at something without touching it. On a full window
 *     that is around a dozen labels rather than the hundred-plus every testid
 *     would draw, and a hundred labels name nothing because none can be read.
 *   - The INNERMOST testid under the pointer is named on a badge that follows
 *     it, so a single button, chip or icon can be identified too — without
 *     spending a persistent label on each of the many.
 *
 * The overlay measures; it never participates in layout. It is `fixed`,
 * `pointer-events: none`, and outside every measured subtree, so turning it on
 * cannot move the thing being named — a diagnostic that perturbs its subject
 * is worse than none.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Smallest box that gets a standing label — below this, hover is the answer. */
const MIN_REGION = { width: 120, height: 40 };

/**
 * A wrapper whose box matches its labelled ancestor within this much is not
 * drawn: a column inside a shell inside a pane is one region to the eye, and
 * three badges stacked on one corner name it three times.
 */
const SAME_BOX_TOLERANCE = 8;

/** Vertical step per nesting level, so a chain of regions reads top-to-bottom. */
const DEPTH_STEP = 15;

interface Label {
  id: string;
  /** 1-based position among labels sharing this id; 0 when the id is unique. */
  occurrence: number;
  left: number;
  top: number;
  width: number;
  height: number;
  depth: number;
}

function measure(root: HTMLElement | null): Label[] {
  const visible = [...document.querySelectorAll<HTMLElement>("[data-testid]")].filter((element) => {
    if (root !== null && root.contains(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  const regions = visible.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= MIN_REGION.width && rect.height >= MIN_REGION.height;
  });
  const kept = new Set(regions);

  const labels: Label[] = [];
  for (const element of regions) {
    const rect = element.getBoundingClientRect();
    let depth = 0;
    let duplicateOfAncestor = false;
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (!kept.has(parent)) continue;
      const parentRect = parent.getBoundingClientRect();
      if (
        depth === 0
        && Math.abs(parentRect.width - rect.width) <= SAME_BOX_TOLERANCE
        && Math.abs(parentRect.height - rect.height) <= SAME_BOX_TOLERANCE
      ) {
        duplicateOfAncestor = true;
        break;
      }
      depth += 1;
    }
    if (duplicateOfAncestor) continue;
    const id = element.getAttribute("data-testid") ?? "";
    labels.push({
      id,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      depth,
      occurrence: 0,
    });
  }
  // A repeated id names several boxes at once, so each gets its position: four
  // bare "assistant-message-body" badges cannot tell the user which message
  // they are pointing at, and "assistant-message-body 3" can.
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label.id, (counts.get(label.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const label of labels) {
    if ((counts.get(label.id) ?? 0) < 2) continue;
    const next = (seen.get(label.id) ?? 0) + 1;
    seen.set(label.id, next);
    label.occurrence = next;
  }
  return labels;
}

/** Same labels, same boxes — used to skip re-renders that would only re-measure. */
function sameLabels(a: Label[], b: Label[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return y !== undefined
      && x.id === y.id
      && x.occurrence === y.occurrence
      && x.depth === y.depth
      && x.left === y.left && x.top === y.top
      && x.width === y.width && x.height === y.height;
  });
}

/** The innermost testid under a point — what "this one" means for a small control. */
function innermostAt(x: number, y: number, root: HTMLElement | null): string | null {
  const under = document.elementsFromPoint(x, y);
  for (const element of under) {
    if (!(element instanceof HTMLElement)) continue;
    if (root !== null && root.contains(element)) continue;
    const owner = element.closest<HTMLElement>("[data-testid]");
    if (owner !== null && (root === null || !root.contains(owner))) {
      return owner.getAttribute("data-testid");
    }
  }
  return null;
}

export function DevComponentLabels(): React.JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  // Measured after paint, and re-measured on anything that can move a box.
  // Layout effect rather than effect: the first frame with the overlay on
  // should already be aligned, not one frame late.
  useLayoutEffect(() => {
    let frame: number | null = null;
    const remeasure = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const next = measure(rootRef.current);
        // Bail when nothing moved. The observer below watches `document.body`,
        // which CONTAINS this overlay, so a state update here would mutate the
        // DOM, wake the observer, and re-measure forever. Identical results end
        // that cycle at the cheapest point.
        setLabels((prev) => (sameLabels(prev, next) ? prev : next));
      });
    };
    remeasure();

    // Scroll is captured, not bubbled: a transcript scrolling inside its own
    // viewport moves every box under it and does not fire on `window`.
    window.addEventListener("scroll", remeasure, { capture: true, passive: true });
    window.addEventListener("resize", remeasure, { passive: true });
    const observer = new MutationObserver((records) => {
      // The overlay's own mutations are not news about the page underneath it.
      // Without this, drawing a label is itself a reason to re-measure.
      const root = rootRef.current;
      if (root !== null && records.every((record) => root.contains(record.target))) return;
      remeasure();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-testid", "hidden"],
    });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", remeasure, { capture: true });
      window.removeEventListener("resize", remeasure);
      observer.disconnect();
    };
  }, []);

  // On `window`, because the overlay itself takes no pointer events — it must
  // not, or naming a button would also mean the button could not be pressed.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const id = innermostAt(event.clientX, event.clientY, rootRef.current);
      setHover(id === null ? null : { id, x: event.clientX, y: event.clientY });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Portalled to `document.body` rather than drawn where it is mounted: a
  // `fixed` box is positioned against the nearest transformed ancestor, not the
  // viewport, and the shell has several. An overlay whose coordinates come from
  // `getBoundingClientRect()` must live where those coordinates mean what they
  // say, or every label sits at an offset from the thing it names.
  return createPortal(
    <div
      ref={rootRef}
      data-testid="dev-component-labels"
      className="pointer-events-none fixed inset-0 z-[9999]"
      aria-hidden="true"
    >
      {labels.map((label) => (
        <div
          key={`${label.id}:${label.occurrence}:${label.left}:${label.top}:${label.depth}`}
          className="absolute border border-dashed border-warning/(--opacity-medium)"
          style={{
            left: label.left,
            top: label.top,
            width: label.width,
            height: label.height,
          }}
        >
          <span
            className="absolute left-0 max-w-full truncate rounded-br-sm bg-warning/(--opacity-strong) px-1 font-mono text-[9px] leading-[13px] text-warning-foreground"
            // Nested regions share a top-left corner, so each level steps down
            // by one badge height and the chain reads as a chain.
            style={{ top: label.depth * DEPTH_STEP }}
          >
            {label.occurrence === 0 ? label.id : `${label.id} ${label.occurrence}`}
          </span>
        </div>
      ))}
      {hover !== null && (
        <span
          data-testid="dev-component-hover-label"
          className="absolute max-w-[60vw] truncate rounded-sm bg-foreground px-1.5 py-0.5 font-mono text-[10px] leading-[15px] text-background"
          // Below-right of the cursor, and flipped when that would leave the
          // viewport — a label that reads off-screen names nothing.
          style={{
            left: Math.min(hover.x + 12, window.innerWidth - 8),
            top: Math.min(hover.y + 18, window.innerHeight - 24),
            transform: hover.x > window.innerWidth - 240 ? "translateX(-100%)" : undefined,
          }}
        >
          {hover.id}
        </span>
      )}
    </div>,
    document.body,
  );
}
