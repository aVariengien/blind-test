import type { ChatComment } from "./types";

// Comments are anchored to the *rendered* text of one message field (what
// you actually selected, markdown already applied), as the quote plus a few
// characters of context either side. Re-finding them is a text search, so
// they don't depend on DOM structure or character offsets staying stable.

const CONTEXT = 32;

export type Anchor = Pick<ChatComment, "messageId" | "field" | "quote" | "prefix" | "suffix">;

/** The element that holds one message field's text, as tagged by <Message>. */
export function fieldElement(root: ParentNode, messageId: string, field: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"][data-field="${field}"]`);
}

function textNodes(el: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Character offset of a DOM point within el's text. */
function offsetOf(el: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

function rangeFromOffsets(el: HTMLElement, start: number, end: number): Range | null {
  const range = document.createRange();
  let pos = 0;
  let started = false;
  for (const node of textNodes(el)) {
    const len = node.data.length;
    if (!started && start <= pos + len) {
      range.setStart(node, start - pos);
      started = true;
    }
    if (started && end <= pos + len) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return null;
}

/** Turn the current selection into an anchor, if it sits inside a single commentable field. */
export function anchorFromSelection(root: HTMLElement): (Anchor & { range: Range }) | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const start = range.startContainer.nodeType === 1 ? (range.startContainer as Element) : range.startContainer.parentElement;
  const el = start?.closest<HTMLElement>("[data-msg-id][data-field]");
  if (!el || !root.contains(el) || !el.contains(range.endContainer)) return null;
  const messageId = el.dataset.msgId!;
  if (messageId.startsWith("tmp-")) return null; // still streaming / not saved yet
  const text = el.textContent || "";
  const a = offsetOf(el, range.startContainer, range.startOffset);
  const b = offsetOf(el, range.endContainer, range.endOffset);
  const quote = text.slice(a, b);
  if (!quote.trim()) return null;
  return {
    messageId,
    field: el.dataset.field === "reasoning" ? "reasoning" : "content",
    quote,
    prefix: text.slice(Math.max(0, a - CONTEXT), a),
    suffix: text.slice(b, b + CONTEXT),
    range: range.cloneRange(),
  };
}

/** Length of the common run where two strings meet (end of a vs start of b, or start vs start). */
function sharedTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function sharedHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Find a comment's quote in its field again, using the context to pick between repeats. */
export function locate(root: ParentNode, c: Anchor): { el: HTMLElement; range: Range } | null {
  const el = fieldElement(root, c.messageId, c.field);
  if (!el) return null;
  const text = el.textContent || "";
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(c.quote); i !== -1; i = text.indexOf(c.quote, i + 1)) {
    const score =
      sharedTail(text.slice(Math.max(0, i - c.prefix.length), i), c.prefix) +
      sharedHead(text.slice(i + c.quote.length, i + c.quote.length + c.suffix.length), c.suffix);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best === -1) return null;
  const range = rangeFromOffsets(el, best, best + c.quote.length);
  return range ? { el, range } : null;
}

/** Caret position under a point, across the two browser APIs for it. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as any;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (d.caretRangeFromPoint) {
    const r: Range | null = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

/** Paint ranges with the CSS Custom Highlight API — no DOM changes under React's feet. */
export function paint(name: string, ranges: Range[]) {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
  else CSS.highlights.delete(name);
}
