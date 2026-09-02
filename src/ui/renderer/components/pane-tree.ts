/**
 * The geometry of the tiled main area.
 *
 * Tiles are arranged freely, tmux style: any tile can be split along either
 * axis, so 1, 2, 3, and 4 tiles are each reachable in more than one shape and
 * the user picks which. That is a TREE, and it lives here as plain data rather
 * than inside the frame component, because every rule worth trusting — the
 * ceiling, what a close does to its parent, whether a shape is even legal — is
 * a statement about the data and should be testable without rendering anything.
 *
 * The tree carries POSITION only. A leaf keeps its `chatGroupId` wherever it
 * moves, so nothing that names a conversation — a keyboard command, a restore,
 * the main-process loop registry — ever has to name a position.
 */

/** Which way a split divides its space. Internal: it reaches callers through
 *  `PaneGutter.axis`, never by name. */
export type SplitAxis = "row" | "column";

export interface PaneLeaf {
  kind: "leaf";
  chatGroupId: string;
}

interface PaneSplit {
  kind: "split";
  axis: SplitAxis;
  children: PaneNode[];
  /** Fractions of the split's extent, one per child, summing to 1. */
  sizes: number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

/** Which side of a tile a session was dropped on. */
export type DropEdge = "left" | "right" | "top" | "bottom";

export const AXIS_OF: Record<DropEdge, SplitAxis> = {
  left: "row",
  right: "row",
  top: "column",
  bottom: "column",
};

/** A drop on these edges puts the new tile FIRST within its split. */
const LEADING: ReadonlySet<DropEdge> = new Set<DropEdge>(["left", "top"]);

export function leaf(chatGroupId: string): PaneLeaf {
  return { kind: "leaf", chatGroupId };
}

/** Every group id in the tree, left to right, top to bottom. */
export function leafIds(node: PaneNode): string[] {
  return node.kind === "leaf"
    ? [node.chatGroupId]
    : node.children.flatMap(leafIds);
}

export function countLeaves(node: PaneNode): number {
  return node.kind === "leaf" ? 1 : node.children.reduce((n, c) => n + countLeaves(c), 0);
}

function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/**
 * Collapse a split that no longer earns its nesting.
 *
 * A split with one child is that child, and a split whose child splits on the
 * same axis is the same geometry drawn with an extra level. Left in place both
 * make two different trees render identically, which would let a test pass on
 * a shape the user cannot actually produce.
 */
function normalize(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return node;

  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, at) => {
    const flat = normalize(child);
    const share = node.sizes[at] ?? 1 / node.children.length;
    if (flat.kind === "split" && flat.axis === node.axis) {
      flat.children.forEach((grandchild, inner) => {
        children.push(grandchild);
        sizes.push(share * (flat.sizes[inner] ?? 1 / flat.children.length));
      });
      return;
    }
    children.push(flat);
    sizes.push(share);
  });

  if (children.length === 1) return children[0]!;
  const total = sizes.reduce((sum, n) => sum + n, 0);
  return {
    kind: "split",
    axis: node.axis,
    children,
    sizes: total > 0 ? sizes.map((n) => n / total) : evenSizes(children.length),
  };
}

/**
 * Split the leaf holding `targetGroupId`, putting `newGroupId` on `edge`.
 *
 * The new tile takes half of the tile it was dropped on and nothing from any
 * other tile — a drop should not resize a part of the screen the user was not
 * pointing at.
 */
export function splitLeaf(
  root: PaneNode,
  targetGroupId: string,
  edge: DropEdge,
  newGroupId: string,
): PaneNode {
  const rewrite = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") {
      if (node.chatGroupId !== targetGroupId) return node;
      const added = leaf(newGroupId);
      return {
        kind: "split",
        axis: AXIS_OF[edge],
        children: LEADING.has(edge) ? [added, node] : [node, added],
        sizes: [0.5, 0.5],
      };
    }
    return { ...node, children: node.children.map(rewrite) };
  };
  return normalize(rewrite(root));
}

/**
 * Remove a leaf, giving its space back to its siblings.
 *
 * Returns the tree unchanged when the id is not in it or is the last leaf —
 * an empty main area is not a state the rest of the app can render.
 */
export function closeLeaf(root: PaneNode, chatGroupId: string): PaneNode {
  if (countLeaves(root) <= 1) return root;
  if (!leafIds(root).includes(chatGroupId)) return root;

  const prune = (node: PaneNode): PaneNode | null => {
    if (node.kind === "leaf") return node.chatGroupId === chatGroupId ? null : node;
    const kept: PaneNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, at) => {
      const survivor = prune(child);
      if (!survivor) return;
      kept.push(survivor);
      sizes.push(node.sizes[at] ?? 1 / node.children.length);
    });
    if (kept.length === 0) return null;
    const total = sizes.reduce((sum, n) => sum + n, 0);
    return normalize({
      kind: "split",
      axis: node.axis,
      children: kept,
      sizes: total > 0 ? sizes.map((n) => n / total) : evenSizes(kept.length),
    });
  };

  return normalize(prune(root) ?? root);
}

/**
 * Where each leaf sits, as percentages of the main area.
 *
 * The frame renders from this rather than from nested flex containers so that
 * a tile's box is one number the layout, a drag hit-test, and a measurement in
 * a test all read the same way.
 */
export interface PaneBox {
  chatGroupId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The canvas height below which the SHORTEST tile stops meeting `tileFloor`.
 *
 * Anything the window draws BESIDE the canvas — a band rather than a float —
 * takes its height out of the grid, so it has to leave this much behind or the
 * tiles are squeezed under the floor the split and resize rules already
 * enforce, and their transcripts collapse to nothing.
 *
 * Read off the boxes rather than counted off the tree because a box carries
 * its share: with an even split the shortest share is `1 / rows` and this is
 * `rows * tileFloor`, and with an uneven one the short tile binds first and
 * this is more. The boxes are also what is actually on screen, so a maximized
 * tile and chat mode's single tile need no special case.
 */
export function minimumCanvasHeight(
  boxes: readonly PaneBox[],
  tileFloor: number,
): number {
  // `box.height` is a PERCENTAGE of the canvas, as `areaStyle` writes it —
  // seeding the fold with 100 keeps the units honest and makes "no tiles" mean
  // one full-height tile rather than a division by a share nobody has.
  const shortestPercent = boxes.reduce((least, box) => Math.min(least, box.height), 100);
  return shortestPercent <= 0 ? tileFloor : Math.ceil((tileFloor * 100) / shortestPercent);
}

export function layoutBoxes(node: PaneNode): PaneBox[] {
  const walk = (
    current: PaneNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ): PaneBox[] => {
    if (current.kind === "leaf") {
      return [{ chatGroupId: current.chatGroupId, left, top, width, height }];
    }
    const boxes: PaneBox[] = [];
    let offset = 0;
    current.children.forEach((child, at) => {
      const share = current.sizes[at] ?? 1 / current.children.length;
      if (current.axis === "row") {
        boxes.push(...walk(child, left + width * offset, top, width * share, height));
      } else {
        boxes.push(...walk(child, left, top + height * offset, width, height * share));
      }
      offset += share;
    });
    return boxes;
  };
  return walk(node, 0, 0, 100, 100);
}

/**
 * A gutter: the boundary between two adjacent children of one split.
 *
 * Identified by where it is in the tree — the split's path from the root and
 * the index of the pair — because a split has no id of its own and the two
 * leaves either side of it may themselves be splits. The geometry is the
 * boundary line as percentages of the main area: zero-thickness along the
 * split's axis, spanning the pair's shared extent across it.
 */
export interface PaneGutter {
  /** Stable while the tree's SHAPE is unchanged; a resize keeps it. */
  key: string;
  axis: SplitAxis;
  /** Child indices from the root down to the split that owns this gutter. */
  path: number[];
  /** The gutter sits between children `index` and `index + 1`. */
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Extent of the two sides along the axis, as percentages of the main area. */
  leading: number;
  trailing: number;
}

export function layoutGutters(node: PaneNode): PaneGutter[] {
  const walk = (
    current: PaneNode,
    path: number[],
    left: number,
    top: number,
    width: number,
    height: number,
  ): PaneGutter[] => {
    if (current.kind === "leaf") return [];
    const gutters: PaneGutter[] = [];
    const extent = current.axis === "row" ? width : height;
    let offset = 0;
    current.children.forEach((child, at) => {
      const share = current.sizes[at] ?? 1 / current.children.length;
      const childLeft = current.axis === "row" ? left + width * offset : left;
      const childTop = current.axis === "row" ? top : top + height * offset;
      const childWidth = current.axis === "row" ? width * share : width;
      const childHeight = current.axis === "row" ? height : height * share;
      gutters.push(...walk(child, [...path, at], childLeft, childTop, childWidth, childHeight));

      const next = current.children[at + 1];
      if (next) {
        const nextShare = current.sizes[at + 1] ?? 1 / current.children.length;
        const boundary = offset + share;
        gutters.push({
          key: `${path.join(".")}:${at}`,
          axis: current.axis,
          path,
          index: at,
          left: current.axis === "row" ? left + width * boundary : left,
          top: current.axis === "row" ? top : top + height * boundary,
          width: current.axis === "row" ? 0 : width,
          height: current.axis === "row" ? height : 0,
          leading: extent * share,
          trailing: extent * nextShare,
        });
      }
      offset += share;
    });
    return gutters;
  };
  return walk(node, [], 0, 0, 100, 100);
}

/**
 * Move a gutter: give the leading side `leadingShare` of what the pair holds
 * together, and the trailing side the rest.
 *
 * Only the two children either side of the gutter change. Their siblings and
 * everything nested inside either of them keep their own proportions, so a
 * drag on one boundary never moves a boundary the user was not holding.
 * Returns the tree unchanged when the gutter does not exist in it.
 */
export function resizeGutter(
  root: PaneNode,
  gutter: Pick<PaneGutter, "path" | "index">,
  leadingShare: number,
): PaneNode {
  const share = Math.min(1, Math.max(0, leadingShare));
  const rewrite = (node: PaneNode, depth: number): PaneNode | null => {
    if (node.kind === "leaf") return null;
    if (depth === gutter.path.length) {
      const a = node.sizes[gutter.index];
      const b = node.sizes[gutter.index + 1];
      if (a === undefined || b === undefined) return null;
      const pair = a + b;
      const sizes = [...node.sizes];
      sizes[gutter.index] = pair * share;
      sizes[gutter.index + 1] = pair * (1 - share);
      return { ...node, sizes };
    }
    const at = gutter.path[depth]!;
    const child = node.children[at];
    if (!child) return null;
    const replaced = rewrite(child, depth + 1);
    if (!replaced) return null;
    const children = [...node.children];
    children[at] = replaced;
    return { ...node, children };
  };
  return rewrite(root, 0) ?? root;
}
