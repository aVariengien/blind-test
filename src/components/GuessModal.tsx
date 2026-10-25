import { useState } from "react";

export default function GuessModal({
  modelIds,
  names,
  onCancel,
  onSubmit,
}: {
  modelIds: string[];
  names: Record<string, string>;
  onCancel: () => void;
  onSubmit: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Who were you talking to?</h2>
        <div className="hint">
          One guess per round. Picking locks the round and reveals the answer.
        </div>
        <div className="pick">
          {modelIds.map((id) => (
            <button key={id} className={picked === id ? "on" : ""} onClick={() => setPicked(id)}>
              {id}
              {names[id] ? <span className="nm">{names[id]}</span> : null}
            </button>
          ))}
        </div>
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!picked} onClick={() => picked && onSubmit(picked)}>
            Lock it in
          </button>
        </div>
      </div>
    </div>
  );
}
