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
 *  `ChatGroupGutter.axis`, never by name. */
export type SplitAxis = "row" | "column";

export interface ChatGroupLeaf {
  kind: "leaf";
  chatGroupId: string;
}

interface ChatGroupSplit {
  kind: "split";
  axis: SplitAxis;
  children: ChatGroupNode[];
  /** Fractions of the split's extent, one per child, summing to 1. */
  sizes: number[];
}

export type ChatGroupNode = ChatGroupLeaf | ChatGroupSplit;

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

export function leaf(chatGroupId: string): ChatGroupLeaf {
  return { kind: "leaf", chatGroupId };
}

/** Every group id in the tree, left to right, top to bottom. */
export function leafIds(node: ChatGroupNode): string[] {
  return node.kind === "leaf"
    ? [node.chatGroupId]
    : node.children.flatMap(leafIds);
}

export function countLeaves(node: ChatGroupNode): number {
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
function normalize(node: ChatGroupNode): ChatGroupNode {
  if (node.kind === "leaf") return node;

  const children: ChatGroupNode[] = [];
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
  root: ChatGroupNode,
  targetGroupId: string,
  edge: DropEdge,
  newGroupId: string,
): ChatGroupNode {
  const rewrite = (node: ChatGroupNode): ChatGroupNode => {
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
export function closeLeaf(root: ChatGroupNode, chatGroupId: string): ChatGroupNode {
  if (countLeaves(root) <= 1) return root;
  if (!leafIds(root).includes(chatGroupId)) return root;

  const prune = (node: ChatGroupNode): ChatGroupNode | null => {
    if (node.kind === "leaf") return node.chatGroupId === chatGroupId ? null : node;
    const kept: ChatGroupNode[] = [];
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
export interface ChatGroupBox {
  chatGroupId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function layoutBoxes(node: ChatGroupNode): ChatGroupBox[] {
  const walk = (
    current: ChatGroupNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ): ChatGroupBox[] => {
    if (current.kind === "leaf") {
      return [{ chatGroupId: current.chatGroupId, left, top, width, height }];
    }
    const boxes: ChatGroupBox[] = [];
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
export interface ChatGroupGutter {
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

export function layoutGutters(node: ChatGroupNode): ChatGroupGutter[] {
  const walk = (
    current: ChatGroupNode,
    path: number[],
    left: number,
    top: number,
    width: number,
    height: number,
  ): ChatGroupGutter[] => {
    if (current.kind === "leaf") return [];
    const gutters: ChatGroupGutter[] = [];
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
  root: ChatGroupNode,
  gutter: Pick<ChatGroupGutter, "path" | "index">,
  leadingShare: number,
): ChatGroupNode {
  const share = Math.min(1, Math.max(0, leadingShare));
  const rewrite = (node: ChatGroupNode, depth: number): ChatGroupNode | null => {
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
