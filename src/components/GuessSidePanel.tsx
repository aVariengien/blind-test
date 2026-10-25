import { useState } from "react";
import type { BlindParticipant } from "../types";

/** Compare's guess UI: a docked side panel, not a blocking modal — stays open
 * while you scroll and read the comparison, so picking a guess doesn't mean
 * losing your place. */
export default function GuessSidePanel({
  participants,
  candidateIds,
  names,
  subtitle,
  submitting,
  onClose,
  onSubmit,
}: {
  participants: BlindParticipant[];
  candidateIds: string[];
  names: Record<string, string>;
  subtitle: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (guesses: Record<string, string>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>({});
  const complete = participants.every((p) => picks[p.handle]);

  return (
    <div className="guess-panel">
      <div className="guess-panel-head">
        <h3>Who's who?</h3>
        <button className="ghost tiny" onClick={onClose}>
          close
        </button>
      </div>
      <div className="hint">{subtitle}</div>
      <div className="guess-panel-rows">
        {participants.map((p) => (
          <label key={p.handle} className="guess-panel-row">
            <span className="mono">@{p.handle}</span>
            <select value={picks[p.handle] || ""} onChange={(e) => setPicks((cur) => ({ ...cur, [p.handle]: e.target.value }))}>
              <option value="" disabled>
                choose…
              </option>
              {candidateIds.map((id) => (
                <option key={id} value={id}>
                  {names[id] || id}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button className="primary" disabled={!complete || submitting} onClick={() => onSubmit(picks)}>
        {submitting ? <span className="spinner" /> : "Lock it in"}
      </button>
    </div>
  );
}
