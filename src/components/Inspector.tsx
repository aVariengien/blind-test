import { useEffect, useRef } from "react";
import type { LogEvent } from "../types";

const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour12: false });

export default function Inspector({
  events,
  onClear,
  onOpenRaw,
  rawAvailable,
  verbose,
  setVerbose,
}: {
  events: LogEvent[];
  onClear: () => void;
  onOpenRaw: () => void;
  rawAvailable: boolean;
  verbose: boolean;
  setVerbose: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <aside className="sidebar">
      <div className="head">
        <span>event log</span>
        <span className="badge">{events.length}</span>
        <span className="spacer" />
        <label className="badge" style={{ cursor: "pointer" }} title="include every content/reasoning delta">
          <input
            type="checkbox"
            checked={verbose}
            onChange={(e) => setVerbose(e.target.checked)}
            style={{ marginRight: 4, verticalAlign: -1 }}
          />
          verbose
        </label>
        <button
          className="ghost tiny"
          onClick={onOpenRaw}
          disabled={!rawAvailable}
          title={rawAvailable ? "full raw jsonl for this round" : "unlocks after you guess"}
        >
          raw
        </button>
        <button className="ghost tiny" onClick={onClear}>
          clear
        </button>
      </div>
      <div
        className="log"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {events.length === 0 ? <div className="hint">Every stream event lands here.</div> : null}
        {events.map((e, i) => (
          <div className={`logline ${e.tone || ""}`} key={i}>
            <span className="ts">{clock(e.t)}</span>
            <span className="k">{e.kind}</span>
            <span className="d">{e.detail}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
