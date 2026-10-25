import type { ChatMessage } from "./types";

// A playground chat is a tree: every message points at its parent, and the
// conversation on screen is the path from a root down to the "head".

export type Tree = {
  byId: Map<string, ChatMessage>;
  /** children in creation order; key "" holds the roots */
  kids: Map<string, ChatMessage[]>;
  /** newest createdAt anywhere under (and including) each message */
  newest: Map<string, number>;
};

export function buildTree(nodes: ChatMessage[]): Tree {
  const byId = new Map(nodes.map((m) => [m.id, m]));
  const kids = new Map<string, ChatMessage[]>();
  for (const m of nodes) {
    const k = m.parentId ?? "";
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k)!.push(m);
  }
  for (const list of kids.values()) list.sort((a, b) => a.createdAt - b.createdAt);
  const newest = new Map<string, number>();
  const visit = (m: ChatMessage): number => {
    let t = m.createdAt;
    for (const c of kids.get(m.id) || []) t = Math.max(t, visit(c));
    newest.set(m.id, t);
    return t;
  };
  for (const r of kids.get("") || []) visit(r);
  return { byId, kids, newest };
}

export function pathTo(tree: Tree, headId: string | null | undefined): ChatMessage[] {
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  for (let m = headId ? tree.byId.get(headId) : undefined; m && !seen.has(m.id); m = m.parentId ? tree.byId.get(m.parentId) : undefined) {
    seen.add(m.id);
    out.push(m);
  }
  return out.reverse();
}

export const siblingsOf = (tree: Tree, m: ChatMessage) => tree.kids.get(m.parentId ?? "") || [m];

/** Where picking a message takes you: down its most recently active line to a leaf. */
export function leafUnder(tree: Tree, id: string): string {
  let cur = id;
  for (;;) {
    const kids = tree.kids.get(cur);
    if (!kids?.length) return cur;
    cur = kids.reduce((a, b) => ((tree.newest.get(b.id) ?? 0) >= (tree.newest.get(a.id) ?? 0) ? b : a)).id;
  }
}
