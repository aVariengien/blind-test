import { useEffect, useRef, type JSX } from "react";
import type { Tree } from "../tree";
import type { ChatMessage } from "../types";

const snippet = (m: ChatMessage) => {
  const t = (m.content || "").replace(/\s+/g, " ").trim();
  if (t) return t;
  if (m.meta?.error) return "(error)";
  if (m.pending) return "…";
  return m.reasoning ? "(thinking only)" : "(empty)";
};

/**
 * The whole conversation as an outline. A straight run of turns stays at one
 * level; wherever you edited or regenerated, the alternatives fan out as
 * indented groups. Click any turn to jump the chat to that branch.
 */
export default function BranchTree({
  tree,
  path,
  headId,
  noteCounts,
  disabled,
  onPick,
  onClose,
}: {
  tree: Tree;
  path: ChatMessage[];
  headId: string | null;
  noteCounts: Map<string, number>;
  disabled: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const onPath = new Set(path.map((m) => m.id));
  const box = useRef<HTMLDivElement>(null);

  // Keep the current branch's last turn in view.
  useEffect(() => {
    box.current?.querySelector(".tn.head")?.scrollIntoView({ block: "nearest" });
  }, [headId]);

  function node(m: ChatMessage) {
    const n = noteCounts.get(m.id) || 0;
    return (
      <div
        key={m.id}
        className={`tn ${m.role} ${onPath.has(m.id) ? "on" : ""} ${m.id === headId ? "head" : ""}`}
        title={m.content.slice(0, 400)}
        onClick={() => !disabled && onPick(m.id)}
      >
        <span className="r">{m.role === "user" ? "you" : "ai"}</span>
        <span className="s">{snippet(m)}</span>
        {n ? <span className="n">{n}</span> : null}
      </div>
    );
  }

  // A run follows single children at one level; a fork opens one group per option.
  function run(first: ChatMessage[]): JSX.Element[] {
    const out: JSX.Element[] = [];
    let level = first;
    while (level.length === 1) {
      out.push(node(level[0]));
      level = tree.kids.get(level[0].id) || [];
    }
    if (level.length > 1) {
      out.push(
        <div className="fork" key={`fork-${level[0].id}`}>
          {level.map((k, i) => (
            <div key={k.id} className={`opt ${onPath.has(k.id) ? "on" : ""}`}>
              <div className="lbl">
                option {i + 1}/{level.length}
              </div>
              {run([k])}
            </div>
          ))}
        </div>,
      );
    }
    return out;
  }

  const roots = tree.kids.get("") || [];
  const forks = [...tree.kids.values()].filter((k) => k.length > 1).length;

  return (
    <aside className="sidebar pg-tree">
      <div className="head">
        <span>branches</span>
        <span className="badge">{forks ? `${forks} fork${forks === 1 ? "" : "s"}` : "no forks yet"}</span>
        <span className="spacer" />
        <button className="ghost tiny" onClick={onClose}>
          close
        </button>
      </div>
      <div className="tree" ref={box}>
        {roots.length ? run(roots) : <div className="hint">Edit one of your messages or regenerate a reply to fork the chat.</div>}
      </div>
    </aside>
  );
}
