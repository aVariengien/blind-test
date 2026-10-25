import { useState } from "react";
import type { BlindParticipant } from "../types";

/** Shared by the room and compare tabs: one guess per handle, from the
 * group's real line-up, submitted all at once to reveal everyone. */
export default function GuessAllModal({
  participants,
  candidateIds,
  names,
  subtitle,
  onCancel,
  onSubmit,
}: {
  participants: BlindParticipant[];
  candidateIds: string[];
  names: Record<string, string>;
  subtitle: string;
  onCancel: () => void;
  onSubmit: (guesses: Record<string, string>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const complete = participants.every((p) => picks[p.handle]);

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Who's who?</h2>
        <div className="hint">{subtitle}</div>
        {participants.map((p) => (
          <div key={p.handle} className="room-guess-row">
            <div className="room-guess-handle mono">@{p.handle}</div>
            <div className="pick">
              {candidateIds.map((id) => (
                <button
                  key={id}
                  className={picks[p.handle] === id ? "on" : ""}
                  onClick={() => setPicks((cur) => ({ ...cur, [p.handle]: id }))}
                >
                  {id}
                  {names[id] ? <span className="nm">{names[id]}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!complete} onClick={() => onSubmit(picks)}>
            Lock it in
          </button>
        </div>
      </div>
    </div>
  );
}
