import { useMemo, useState } from "react";
import type { Round } from "../types";

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

export default function Stats({
  rounds,
  onOpenRound,
  onDeleteRound,
}: {
  rounds: Round[];
  onOpenRound: (id: string) => void;
  onDeleteRound: (id: string) => void;
}) {
  const groupNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rounds) m.set(r.groupId, r.groupName);
    return m;
  }, [rounds]);
  const [groupFilter, setGroupFilter] = useState<string>("all");

  const scoped = groupFilter === "all" ? rounds : rounds.filter((r) => r.groupId === groupFilter);
  const played = scoped.filter((r) => r.revealed && r.actualModel);

  const correct = played.filter((r) => r.correct).length;
  const avgQuestions = played.length
    ? (played.reduce((s, r) => s + r.userMessageCount, 0) / played.length).toFixed(1)
    : "—";

  // Current streak, counted backwards from the most recent finished round.
  const byRecent = [...played].sort((a, b) => (b.guessedAt || 0) - (a.guessedAt || 0));
  let streak = 0;
  for (const r of byRecent) {
    if (r.correct) streak++;
    else break;
  }

  // Per-model recall (spotted it when it showed up) and precision (right when you called it).
  type Row = { id: string; seen: number; hit: number; guessed: number; guessedHit: number };
  const rows = new Map<string, Row>();
  const touch = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, seen: 0, hit: 0, guessed: 0, guessedHit: 0 }));
    return r;
  };
  for (const r of played) {
    const actual = touch(r.actualModel!);
    actual.seen++;
    if (r.correct) actual.hit++;
    if (r.guess) {
      const g = touch(r.guess);
      g.guessed++;
      if (r.correct) g.guessedHit++;
    }
  }
  const table = [...rows.values()].sort((a, b) => b.seen - a.seen || a.id.localeCompare(b.id));

  // Confusion matrix over every model that appeared as an answer or a guess.
  const axis = table.map((r) => r.id);
  const cell = new Map<string, number>();
  for (const r of played) {
    const k = `${r.actualModel}|${r.guess}`;
    cell.set(k, (cell.get(k) || 0) + 1);
  }
  const maxCell = Math.max(1, ...[...cell.values()]);

  const best = table.filter((r) => r.seen >= 2).sort((a, b) => b.hit / b.seen - a.hit / a.seen)[0];
  const worst = [...table].filter((r) => r.seen >= 2).sort((a, b) => a.hit / a.seen - b.hit / b.seen)[0];

  return (
    <div className="page wide">
      <h1>How good are you?</h1>
      <div className="sub" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span>Only rounds you actually guessed count.</span>
        <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
          <option value="all">all groups</option>
          {[...groupNames.entries()].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="tiles">
        <div className="tile accent">
          <div className="n">{pct(correct, played.length)}</div>
          <div className="l">accuracy</div>
        </div>
        <div className="tile">
          <div className="n">
            {correct}/{played.length}
          </div>
          <div className="l">correct</div>
        </div>
        <div className="tile">
          <div className="n">{streak}</div>
          <div className="l">current streak</div>
        </div>
        <div className="tile">
          <div className="n">{avgQuestions}</div>
          <div className="l">questions / round</div>
        </div>
        <div className="tile">
          <div className="n">{scoped.length - played.length}</div>
          <div className="l">unfinished</div>
        </div>
      </div>

      {best && worst && best.id !== worst.id ? (
        <div className="hint">
          Easiest for you: <span className="mono">{best.id}</span> ({pct(best.hit, best.seen)}) · hardest:{" "}
          <span className="mono">{worst.id}</span> ({pct(worst.hit, worst.seen)}).
        </div>
      ) : null}

      <h2>Per model</h2>
      {table.length === 0 ? (
        <div className="hint">Nothing yet. Play a round and guess.</div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>model</th>
              <th className="num">appeared</th>
              <th className="num">spotted</th>
              <th style={{ width: 150 }}>recall</th>
              <th className="num">you guessed it</th>
              <th className="num">precision</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr key={r.id}>
                <td className="id">{r.id}</td>
                <td className="num">{r.seen}</td>
                <td className="num">{r.hit}</td>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div className="bar" style={{ flex: 1 }}>
                      <i style={{ width: r.seen ? `${(r.hit / r.seen) * 100}%` : 0 }} />
                    </div>
                    <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 34 }}>{pct(r.hit, r.seen)}</span>
                  </div>
                </td>
                <td className="num">{r.guessed}</td>
                <td className="num">{pct(r.guessedHit, r.guessed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {axis.length > 1 ? (
        <>
          <h2>Confusion</h2>
          <div className="hint">Rows: who it actually was. Columns: who you said it was.</div>
          <div className="mwrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th />
                  {axis.map((id) => (
                    <th key={id} title={id}>
                      {short(id)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {axis.map((actual) => (
                  <tr key={actual}>
                    <th className="rowh" title={actual}>
                      {short(actual)}
                    </th>
                    {axis.map((guess) => {
                      const n = cell.get(`${actual}|${guess}`) || 0;
                      const diag = actual === guess;
                      return (
                        <td
                          key={guess}
                          className={diag ? "diag" : undefined}
                          style={
                            n
                              ? {
                                  background: diag
                                    ? `rgba(200,168,0,${0.18 + 0.62 * (n / maxCell)})`
                                    : `rgba(192,57,43,${0.08 + 0.42 * (n / maxCell)})`,
                                }
                              : undefined
                          }
                        >
                          {n || ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h2>Rounds</h2>
      <div className="rounds-list">
        {[...scoped]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((r) => (
            <div className="r" key={r.id} onClick={() => onOpenRound(r.id)}>
              <span className={`dot ${r.revealed ? (r.correct ? "right" : "wrong") : "open"}`} />
              <span style={{ color: "var(--muted)", width: 36 }}>#{r.seq}</span>
              <span className="mono">{r.revealed ? r.actualModel : "in progress"}</span>
              {r.revealed && !r.correct ? (
                <span className="badge bad">said {short(r.guess || "")}</span>
              ) : null}
              <span className="spacer" />
              <span className="badge">{r.groupName}</span>
              <span style={{ color: "var(--muted)" }}>{r.userMessageCount}q</span>
              <span style={{ color: "var(--muted)", width: 120, textAlign: "right" }}>
                {new Date(r.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
              <button
                className="ghost tiny"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete round #${r.seq}? This removes it from your stats.`)) onDeleteRound(r.id);
                }}
              >
                del
              </button>
            </div>
          ))}
        {scoped.length === 0 ? <div className="hint">No rounds recorded yet.</div> : null}
      </div>
    </div>
  );
}

function short(id: string) {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}
