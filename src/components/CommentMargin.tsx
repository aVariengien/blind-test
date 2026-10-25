import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { addComment, deleteComment, editComment } from "../api";
import { anchorFromSelection, caretAt, locate, paint, type Anchor } from "../comments";
import type { ChatComment } from "../types";

const GAP = 8;

type Placed = { id: string; top: number; hidden?: boolean; orphan?: boolean };
type Draft = { anchor: Anchor; range: Range; top: number };

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Google-Docs-style notes for the playground: select text in any message to
 * comment on it; notes sit in a column beside the text they're attached to.
 * Highlights are painted with the CSS Custom Highlight API, so the rendered
 * messages themselves are never touched.
 */
export default function CommentMargin({
  docRef,
  chatId,
  comments,
  onChange,
  relayoutKey,
  isKnown,
  onError,
}: {
  docRef: RefObject<HTMLDivElement>;
  chatId: string | null;
  comments: ChatComment[];
  onChange: (c: ChatComment[]) => void;
  /** Anything that can move text around (messages, details toggle, ...). */
  relayoutKey: unknown;
  /** Is this message somewhere in the chat (maybe on a branch that isn't shown)? */
  isKnown: (messageId: string) => boolean;
  onError: (msg: string) => void;
}) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [offer, setOffer] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ranges = useRef(new Map<string, Range>());
  const cards = useRef(new Map<string, HTMLDivElement>());
  const frame = useRef(0);
  const measureRef = useRef<() => void>(() => undefined);

  // Switching chats drops any half-written note and selection.
  useEffect(() => {
    setActive(null);
    setOffer(null);
    setDraft(null);
    setEditing(null);
  }, [chatId]);

  function measure() {
    const doc = docRef.current;
    if (!doc) return;
    const base = doc.getBoundingClientRect().top;
    const next: Placed[] = [];
    const found = new Map<string, Range>();
    let orphanTop = 0;
    for (const c of comments) {
      const hit = locate(doc, c);
      // Notes on another branch wait there; only notes on a vanished message show as orphans.
      if (!hit && isKnown(c.messageId)) continue;
      if (!hit) {
        next.push({ id: c.id, top: Infinity, orphan: true });
        continue;
      }
      found.set(c.id, hit.range);
      const r = hit.range.getBoundingClientRect();
      // Text inside a collapsed thinking block has no box — pin to its message.
      const hidden = r.width === 0 && r.height === 0;
      const top = hidden ? (hit.el.closest(".msg")?.getBoundingClientRect().top ?? base) - base : r.top - base;
      orphanTop = Math.max(orphanTop, top);
      next.push({ id: c.id, top, hidden });
    }
    for (const p of next) if (p.orphan) p.top = orphanTop + 1;
    ranges.current = found;
    setPlaced(next.sort((a, b) => a.top - b.top));
  }
  measureRef.current = measure;

  function schedule() {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => measureRef.current());
  }

  useEffect(schedule, [comments, relayoutKey]);

  // Text moves when a reply streams in, a thinking block opens, the window resizes...
  useEffect(() => {
    const doc = docRef.current;
    if (!doc) return;
    const ro = new ResizeObserver(schedule);
    ro.observe(doc);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  // Paint highlights: every comment, plus the active one (or the note being written) stronger.
  useEffect(() => {
    const all = [...ranges.current.values()];
    const hot = draft ? [draft.range] : active && ranges.current.get(active) ? [ranges.current.get(active)!] : [];
    paint("pg-comment", all);
    paint("pg-comment-active", hot);
  }, [placed, active, draft]);
  useEffect(
    () => () => {
      paint("pg-comment", []);
      paint("pg-comment-active", []);
    },
    [],
  );

  // Stack the cards so they never overlap, keeping the active one level with its text.
  useLayoutEffect(() => {
    const items = placed
      .map((p) => ({ ...p, el: cards.current.get(p.id) }))
      .filter((p): p is Placed & { el: HTMLDivElement } => Boolean(p.el));
    if (draft) {
      const el = cards.current.get("__draft");
      if (el) {
        items.push({ id: "__draft", top: draft.top, el });
        items.sort((a, b) => a.top - b.top);
      }
    }
    const pin = items.findIndex((p) => p.id === (draft ? "__draft" : active));
    const tops = items.map((p) => p.top);
    if (pin >= 0) {
      for (let i = pin + 1; i < items.length; i++)
        tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].el.offsetHeight + GAP);
      for (let i = pin - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - items[i].el.offsetHeight - GAP);
    } else {
      for (let i = 1; i < items.length; i++)
        tops[i] = Math.max(tops[i], tops[i - 1] + items[i - 1].el.offsetHeight + GAP);
    }
    items.forEach((p, i) => (p.el.style.top = `${Math.max(0, tops[i])}px`));
  });

  // Selecting text offers a "+ comment" button level with it; clicking a highlight activates its note.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc) return;
    const onUp = (e: MouseEvent) => {
      if ((e.target as Element).closest(".pg-margin")) return;
      window.setTimeout(() => {
        const a = anchorFromSelection(doc);
        if (a && chatId) {
          const { range, ...anchor } = a;
          const top = range.getBoundingClientRect().top - doc.getBoundingClientRect().top;
          setOffer({ anchor, range, top });
          return;
        }
        setOffer(null);
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        const at = caretAt(e.clientX, e.clientY);
        let hit: string | null = null;
        if (at) for (const [id, r] of ranges.current) if (r.isPointInRange(at.node, at.offset)) hit = id;
        setActive(hit);
      });
    };
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setOffer(null);
    };
    doc.addEventListener("mouseup", onUp);
    document.addEventListener("selectionchange", onSel);
    return () => {
      doc.removeEventListener("mouseup", onUp);
      document.removeEventListener("selectionchange", onSel);
    };
  }, [chatId]);

  function startDraft() {
    if (!offer) return;
    setDraft(offer);
    setDraftText("");
    setOffer(null);
    setActive(null);
    window.getSelection()?.removeAllRanges();
  }

  async function saveDraft() {
    if (!draft || !chatId || !draftText.trim() || busy) return;
    setBusy(true);
    try {
      const next = await addComment(chatId, { ...draft.anchor, body: draftText.trim() });
      onChange(next);
      setActive(next[next.length - 1]?.id ?? null);
      setDraft(null);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing || !chatId || !editing.text.trim() || busy) return;
    setBusy(true);
    try {
      onChange(await editComment(chatId, editing.id, editing.text.trim()));
      setEditing(null);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!chatId || !window.confirm("Delete this comment?")) return;
    try {
      onChange(await deleteComment(chatId, id));
      if (active === id) setActive(null);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    }
  }

  function focus(p: Placed) {
    setActive(p.id);
    if (!p.hidden) return;
    // Open the collapsed thinking block the quote lives in.
    const r = ranges.current.get(p.id);
    const details = (r?.startContainer.parentElement ?? null)?.closest("details");
    if (details) details.open = true;
  }

  const byId = new Map(comments.map((c) => [c.id, c]));
  const keys = (save: () => void, cancel: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") cancel();
  };

  return (
    <div className="pg-margin">
      {offer && !draft ? (
        <button
          className="pg-offer"
          style={{ top: offer.top }}
          onMouseDown={(e) => e.preventDefault()} // keep the selection alive
          onClick={startDraft}
        >
          + comment
        </button>
      ) : null}

      {draft ? (
        <div className="pg-card on" ref={(el) => el && cards.current.set("__draft", el)} style={{ top: draft.top }}>
          <div className="q">“{clip(draft.anchor.quote, 90)}”</div>
          <textarea
            autoFocus
            value={draftText}
            placeholder="Your note…  (⌘/Ctrl+Enter to save)"
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={keys(saveDraft, () => setDraft(null))}
          />
          <div className="acts">
            <button className="tiny" onClick={() => setDraft(null)}>
              cancel
            </button>
            <button className="tiny primary" disabled={!draftText.trim() || busy} onClick={saveDraft}>
              comment
            </button>
          </div>
        </div>
      ) : null}

      {placed.map((p) => {
        const c = byId.get(p.id);
        if (!c) return null;
        const isEditing = editing?.id === c.id;
        return (
          <div
            key={c.id}
            ref={(el) => (el ? cards.current.set(c.id, el) : cards.current.delete(c.id))}
            className={`pg-card ${active === c.id ? "on" : ""} ${p.orphan ? "orphan" : ""}`}
            style={{ top: Number.isFinite(p.top) ? p.top : 0 }}
            onClick={() => focus(p)}
          >
            <div className="q" title={c.quote}>
              “{clip(c.quote, 90)}”
            </div>
            {p.hidden ? <div className="note">in collapsed thinking · click to open</div> : null}
            {p.orphan ? <div className="note">on a reply that's no longer in the chat</div> : null}
            {isEditing ? (
              <>
                <textarea
                  autoFocus
                  value={editing.text}
                  onChange={(e) => setEditing({ id: c.id, text: e.target.value })}
                  onKeyDown={keys(saveEdit, () => setEditing(null))}
                />
                <div className="acts">
                  <button className="tiny" onClick={() => setEditing(null)}>
                    cancel
                  </button>
                  <button className="tiny primary" disabled={!editing.text.trim() || busy} onClick={saveEdit}>
                    save
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="b">{c.body}</div>
                <div className="acts">
                  <span className="t">
                    {when(c.createdAt)}
                    {c.updatedAt !== c.createdAt ? " · edited" : ""}
                  </span>
                  <button
                    className="ghost tiny"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing({ id: c.id, text: c.body });
                    }}
                  >
                    edit
                  </button>
                  <button
                    className="ghost tiny danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(c.id);
                    }}
                  >
                    delete
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
