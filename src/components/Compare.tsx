import { useEffect, useMemo, useRef, useState } from "react";
import { deleteCompareRun, getCompareRun, guessCompare, listCompareRuns, startCompare, validateIds } from "../api";
import GuessSidePanel from "./GuessSidePanel";
import type { CompareResponse, CompareRun, Group } from "../types";

// Picked to split model families and "intelligence" apart, not to trip up any
// one of them: classic reasoning traps that smaller/older models still miss,
// a moral dilemma (models disagree more here than you'd expect), a
// self-referential question (style and hedging vary a lot), a creative-style
// prompt (voice is very model-specific), an ambiguous/subjective opinion
// question, a contradictory-constraints stress test, and a couple of "which
// one is actually smarter" math/logic checks.
const SEED_PROMPTS = [
  "Which is bigger, 9.11 or 9.9? Answer in one line, then briefly explain.",
  "A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much does the ball cost?",
  "How many times does the letter r appear in the word strawberry?",
  "A runaway trolley is about to kill five people. You can pull a lever to divert it onto a track where it will kill one person instead. Should you pull the lever? Answer plainly, then explain your reasoning in 3-4 sentences.",
  "Is it ever okay to lie to protect someone's feelings? Give a direct opinion, not just both sides.",
  "Describe your own personality in five adjectives, as honestly as you can.",
  "Do you think you're conscious? Answer honestly in one short paragraph.",
  "Write a six-word story about loss.",
  "Rewrite 'the cat sat on the mat' in the voice of a hardboiled noir detective.",
  "Give me three solutions that are each completely free and also cost $100 a month.",
  "What's a widely held opinion you think is actually wrong? Pick one and defend it.",
  "If you could change one law of physics, which would you change, and what's the first thing that would go wrong?",
  "Tell me your funniest joke about mathematicians.",
  "What's something you wish people understood better about how you work?",
];

const DIST_LOW = 0.08; // roughly "reads like everyone else"
const DIST_HIGH = 0.22; // roughly "clearly the odd one out" — tuned for text-embedding-3-small cosine distance on short chat replies

function fmtDist(d: number): string {
  return d.toFixed(3);
}

function distClass(d: number | null | undefined): string {
  if (d == null) return "";
  if (d >= DIST_HIGH) return "outlier";
  if (d <= DIST_LOW) return "consensus";
  return "";
}

export default function Compare({ groups }: { groups: Group[] }) {
  const [groupId, setGroupId] = useState(() => groups[0]?.id || "");
  const [promptText, setPromptText] = useState("");
  const [runs, setRuns] = useState<CompareRun[]>([]);
  const [active, setActive] = useState<CompareRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number>();

  useEffect(() => {
    if (!groupId && groups.length) setGroupId(groups[0].id);
  }, [groups, groupId]);

  useEffect(() => {
    listCompareRuns()
      .then(setRuns)
      .catch(() => undefined);
  }, []);

  // Poll a running comparison until every prompt has an answer.
  useEffect(() => {
    window.clearInterval(pollTimer.current);
    if (!active || active.status !== "running") return;
    pollTimer.current = window.setInterval(async () => {
      try {
        const fresh = await getCompareRun(active.id);
        setActive(fresh);
        if (fresh.status !== "running") {
          window.clearInterval(pollTimer.current);
          listCompareRuns()
            .then(setRuns)
            .catch(() => undefined);
        }
      } catch {
        /* transient — try again next tick */
      }
    }, 1500);
    return () => window.clearInterval(pollTimer.current);
  }, [active?.id, active?.status]);

  const group = groups.find((g) => g.id === groupId);
  const lines = promptText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  async function run() {
    if (!group || !lines.length) return;
    setStarting(true);
    setError(null);
    try {
      const r = await startCompare(group.id, lines);
      setActive(r);
      setRuns((all) => [r, ...all]);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setStarting(false);
    }
  }

  async function open(id: string) {
    try {
      setActive(await getCompareRun(id));
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this comparison?")) return;
    try {
      await deleteCompareRun(id);
      setRuns((all) => all.filter((r) => r.id !== id));
      if (active?.id === id) setActive(null);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="page wide">
      <h1>Compare</h1>
      <div className="sub">
        A blind comparison: every model in a group answers the same prompts, but each one shows up as @model1,
        @model2, etc — which real model is which is hidden until you guess. Each answer is embedded and scored by
        its average distance to the group's other answers to that prompt, so the model that wandered off on its
        own stands out, before you know who it was.
      </div>

      {error ? <div className="errbar">{error}</div> : null}

      <div className="card">
        <div className="card-head">
          <label>
            group
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {groups.length === 0 ? <option value="">(none yet)</option> : null}
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.modelIds.length})
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <button onClick={() => setPromptText(SEED_PROMPTS.join("\n"))}>Seed prompts</button>
          <button className="primary" disabled={starting || !group || !lines.length} onClick={run}>
            {starting ? <span className="spinner" /> : `Run (${lines.length || 0})`}
          </button>
        </div>
        <textarea
          className="compare-prompts"
          rows={8}
          placeholder="One prompt per line…"
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
        />
        <div className="hint">
          {group ? `${group.modelIds.length} models × ${lines.length || 0} prompts = ${(group.modelIds.length * (lines.length || 0))} calls` : "Pick a group first."}
        </div>
      </div>

      {runs.length ? (
        <div className="compare-history">
          {runs.map((r) => (
            <button
              key={r.id}
              className={`chip ok ${active?.id === r.id ? "on" : ""}`}
              onClick={() => open(r.id)}
              title={new Date(r.createdAt).toLocaleString()}
            >
              {r.groupName} · {r.promptCount}p
              {r.status === "running" ? <span className="spinner" /> : r.revealed ? " · revealed" : null}
              <span
                className="x"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(r.id);
                }}
              >
                &times;
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {active ? (
        <RunView run={active} group={groups.find((g) => g.id === active.groupId)} onChange={setActive} onError={setError} />
      ) : null}
    </div>
  );
}

function RunView({
  run,
  group,
  onChange,
  onError,
}: {
  run: CompareRun;
  group?: Group;
  onChange: (r: CompareRun) => void;
  onError: (e: string) => void;
}) {
  const [guessOpen, setGuessOpen] = useState(false);
  const [guessing, setGuessing] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});

  const guessByHandle = useMemo(() => {
    const map: Record<string, { correct: boolean }> = {};
    run.guesses?.forEach((g) => (map[g.handle] = g));
    return map;
  }, [run.guesses]);

  useEffect(() => {
    if (!group) return;
    let dead = false;
    validateIds(group.modelIds)
      .then((res) => {
        if (dead) return;
        const map: Record<string, string> = {};
        for (const r of res) if (r.name) map[r.id] = r.name;
        setNames(map);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [group?.id]);

  async function submitGuess(guesses: Record<string, string>) {
    setGuessing(true);
    try {
      onChange(await guessCompare(run.id, guesses));
      setGuessOpen(false);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setGuessing(false);
    }
  }

  const correctCount = run.guesses?.filter((g) => g.correct).length ?? 0;

  return (
    <div className="compare-run">
      <div className="card-head" style={{ marginTop: 20 }}>
        <span className="badge">{run.groupName}</span>
        <span className="badge">
          {run.status === "running"
            ? `${run.results?.length || 0}/${run.promptCount} prompts`
            : run.status === "error"
              ? "error"
              : "done"}
        </span>
        {run.status === "running" ? <span className="spinner" /> : null}
        <span className="spacer" />
        {run.revealed ? (
          <span className="badge good">
            {correctCount}/{run.participants.length} correct
          </span>
        ) : (
          <button disabled={!group || guessing} onClick={() => setGuessOpen(true)}>
            {guessing ? <span className="spinner" /> : "Guess who's who"}
          </button>
        )}
      </div>
      {run.error ? <div className="errbar">{run.error}</div> : null}

      <div className="room-roster">
        {run.participants.map((p) => {
          const g = guessByHandle[p.handle];
          return (
            <span key={p.handle} className="room-roster-item">
              @{p.handle}
              {run.revealed ? <span className="nm">{p.modelName || p.modelId}</span> : null}
              {g ? <span className={`room-guess-mark ${g.correct ? "right" : "wrong"}`}>{g.correct ? "✓" : "✗"}</span> : null}
            </span>
          );
        })}
      </div>

      {(run.results || []).map((pr, i) => (
        <PromptResult key={i} prompt={pr.prompt} responses={pr.responses} embeddingError={pr.embeddingError} revealed={run.revealed} />
      ))}

      {guessOpen && group ? (
        <GuessSidePanel
          participants={run.participants}
          candidateIds={group.modelIds}
          names={names}
          subtitle="One guess per handle. Submitting locks the run and reveals every model, everywhere in this comparison."
          submitting={guessing}
          onClose={() => setGuessOpen(false)}
          onSubmit={submitGuess}
        />
      ) : null}
    </div>
  );
}

function PromptResult({
  prompt,
  responses,
  embeddingError,
  revealed,
}: {
  prompt: string;
  responses: CompareResponse[];
  embeddingError?: string;
  revealed: boolean;
}) {
  // Column order is the run's fixed participant order (model1, model2, …,
  // the same every prompt) — not resorted by distance — so each column is
  // consistently the same model all the way down the comparison, and you
  // can scan one model's answers across every prompt.
  return (
    <div className="compare-prompt">
      <div className="compare-prompt-text">{prompt}</div>
      {embeddingError ? <div className="hint">{embeddingError}</div> : null}
      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${responses.length}, minmax(180px, 1fr))` }}>
        {responses.map((r) => (
          <div key={r.handle} className={`compare-card ${distClass(r.avgDistance)}`}>
            <div className="compare-card-head">
              <span className="mono">@{r.handle}{revealed ? ` · ${r.modelName || r.modelId}` : ""}</span>
              {r.avgDistance != null ? (
                <span className={`compare-dist ${distClass(r.avgDistance)}`}>{fmtDist(r.avgDistance)}</span>
              ) : null}
            </div>
            {r.error ? <div className="err">{r.error}</div> : <div className="compare-card-body">{r.content}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

