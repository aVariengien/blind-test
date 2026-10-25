import { useEffect, useMemo, useRef, useState } from "react";
import { calibrateGroup, deleteGroup, getGroups, saveGroup, searchCatalog, validateIds } from "../api";
import type { Group, Validation } from "../types";
import ProviderPicker from "./ProviderPicker";

const STARTER = [
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-5",
  "google/gemini-2.5-pro",
  "deepseek/deepseek-chat-v3.1",
  "meta-llama/llama-3.3-70b-instruct",
  "x-ai/grok-4",
];

export default function Groups({ groups, onChange }: { groups: Group[]; onChange: (g: Group[]) => void }) {
  const [creating, setCreating] = useState(false);
  // The blank card is always up when there is nothing to play with yet.
  const showCreate = creating || groups.length === 0;
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A group's speed test runs in the background after it's saved. Poll while
  // any group is still "pending" so the card picks up the result on its own.
  const anyPending = groups.some((g) => g.speedStatus === "pending");
  useEffect(() => {
    if (!anyPending) return;
    const t = window.setInterval(() => {
      getGroups().then(onChange).catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(t);
  }, [anyPending]);

  async function seedStarter() {
    setSeeding(true);
    setError(null);
    try {
      const results = await validateIds(STARTER);
      const ok = results.filter((r) => r.valid).map((r) => r.id);
      if (ok.length < 2) throw new Error("none of the starter ids are on OpenRouter right now");
      const { groups: next } = await saveGroup({ name: "Starter six", modelIds: ok });
      onChange(next);
      setCreating(false);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="page wide">
      <h1>Model groups</h1>
      <div className="sub">
        A group is the line-up a round draws from, and the list you pick your guess out of. Model ids are checked
        against OpenRouter's live catalogue before a group can be saved.
      </div>

      {error ? <div className="errbar">{error}</div> : null}

      {groups.map((g) => (
        <GroupCard key={g.id} group={g} onChange={onChange} onError={setError} />
      ))}

      {showCreate ? (
        <GroupCard
          group={{ id: "", name: "", modelIds: [], createdAt: 0, updatedAt: 0 }}
          onChange={(next) => {
            onChange(next);
            setCreating(false);
          }}
          onError={setError}
          onCancel={groups.length ? () => setCreating(false) : undefined}
        />
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="primary" onClick={() => setCreating(true)}>
            New group
          </button>
          {groups.length === 0 ? (
            <button onClick={seedStarter} disabled={seeding}>
              {seeding ? <span className="spinner" /> : "Seed a starter group"}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GroupCard({
  group,
  onChange,
  onError,
  onCancel,
}: {
  group: Group;
  onChange: (g: Group[]) => void;
  onError: (e: string | null) => void;
  onCancel?: () => void;
}) {
  const isNew = !group.id;
  const [name, setName] = useState(group.name);
  const [ids, setIds] = useState<string[]>(group.modelIds);
  const [checks, setChecks] = useState<Record<string, Validation>>({});
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recalibrating, setRecalibrating] = useState(false);

  useEffect(() => {
    let dead = false;
    if (ids.length === 0) {
      setChecks({});
      return;
    }
    setChecking(true);
    validateIds(ids)
      .then((res) => {
        if (dead) return;
        const map: Record<string, Validation> = {};
        for (const r of res) map[r.id] = r;
        setChecks(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!dead) setChecking(false);
      });
    return () => {
      dead = true;
    };
  }, [ids.join(" ")]);

  const invalid = ids.filter((id) => checks[id] && !checks[id].valid);
  const dirty = name !== group.name || ids.join(",") !== group.modelIds.join(",");
  const canSave = Boolean(name.trim()) && ids.length >= 2 && invalid.length === 0 && !checking && (dirty || isNew);

  async function save() {
    setSaving(true);
    onError(null);
    try {
      const { groups } = await saveGroup({ id: group.id || undefined, name: name.trim(), modelIds: ids });
      onChange(groups);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete group "${group.name}"? Past rounds and stats are kept.`)) return;
    try {
      onChange(await deleteGroup(group.id));
    } catch (err) {
      onError(String(err));
    }
  }

  async function recalibrate() {
    setRecalibrating(true);
    onError(null);
    try {
      onChange(await calibrateGroup(group.id));
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setRecalibrating(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <input
          value={name}
          placeholder="group name"
          onChange={(e) => setName(e.target.value)}
          style={{ fontFamily: "var(--serif)", fontSize: 19, width: 260 }}
        />
        <span className="badge">{ids.length} models</span>
        {checking ? <span className="spinner" /> : null}
        <span className="spacer" />
        {isNew && onCancel ? <button onClick={onCancel}>Cancel</button> : null}
        {!isNew ? (
          <button className="danger" onClick={remove}>
            Delete
          </button>
        ) : null}
        <button className="primary" disabled={!canSave || saving} onClick={save}>
          {saving ? <span className="spinner" /> : isNew ? "Create" : dirty ? "Save" : "Saved"}
        </button>
      </div>

      <div className="chips">
        {ids.map((id) => {
          const v = checks[id];
          return (
            <span key={id} className={`chip ${v && !v.valid ? "bad" : "ok"}`}>
              {id}
              {v?.valid && v.name ? <span className="nm">{v.name}</span> : null}
              {v && !v.valid ? <span className="nm">unknown id</span> : null}
              <span className="x" onClick={() => setIds(ids.filter((x) => x !== id))}>
                &times;
              </span>
            </span>
          );
        })}
        {ids.length === 0 ? <span className="hint">No models yet &mdash; add at least two.</span> : null}
      </div>

      {ids.some((id) => checks[id]?.valid) ? (
        <div className="providers">
          <div className="hint">
            Providers &mdash; each model is pinned to one OpenRouter host, everywhere in the app, with no fallback.
            Changing one re-runs the speed test of every group that uses the model.
          </div>
          {ids
            .filter((id) => checks[id]?.valid)
            .map((id) => (
              <div className="provider-row" key={id}>
                <span className="mono">{id}</span>
                <ProviderPicker
                  modelId={id}
                  // Picks up the re-run speed tests; a not-yet-created card has none (and would close on onChange).
                  onChanged={isNew ? undefined : () => getGroups().then(onChange).catch(() => undefined)}
                />
              </div>
            ))}
        </div>
      ) : null}

      {!isNew ? (
        <SpeedInfo group={group} recalibrating={recalibrating} onRecalibrate={recalibrate} />
      ) : null}

      {invalid.map((id) => {
        const s = checks[id]?.suggestions || [];
        if (!s.length) return null;
        return (
          <div className="hint" key={id}>
            <span className="mono">{id}</span> &rarr; did you mean{" "}
            {s.map((sug, i) => (
              <span key={sug}>
                {i > 0 ? ", " : ""}
                <a
                  href="#"
                  className="mono"
                  onClick={(e) => {
                    e.preventDefault();
                    setIds(ids.map((x) => (x === id ? sug : x)));
                  }}
                >
                  {sug}
                </a>
              </span>
            ))}
            ?
          </div>
        );
      })}

      <AddModel existing={ids} onAdd={(id) => setIds([...ids, id])} />

      {ids.length === 1 ? <div className="hint">A group needs at least two models to be guessable.</div> : null}
    </div>
  );
}

function AddModel({ existing, onAdd }: { existing: string[]; onAdd: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const { models } = await searchCatalog(q.trim());
        setHits(models.filter((m) => !existing.includes(m.id)));
        setCursor(0);
        setOpen(true);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q, existing.join(" ")]);

  const visible = useMemo(() => hits.slice(0, 12), [hits]);

  function add(id: string) {
    if (!id || existing.includes(id)) return;
    onAdd(id);
    setQ("");
    setHits([]);
    setOpen(false);
  }

  return (
    <div className="addrow">
      <input
        value={q}
        placeholder="openrouter model id, e.g. anthropic/claude-sonnet-4.5"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, visible.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            add(open && visible[cursor] ? visible[cursor].id : q.trim());
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <button onClick={() => add(q.trim())} disabled={!q.trim()}>
        Add
      </button>
      {open && visible.length ? (
        <div className="suggest">
          {visible.map((m, i) => (
            <div key={m.id} className={i === cursor ? "on" : ""} onMouseDown={() => add(m.id)}>
              {m.id}
              <span className="nm">{m.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Every model in a group is throttled down to the slowest one's pace (+25%
 * buffer) so a round's timing can't be used to tell models apart. This shows
 * what that test found, and lets you rerun it.
 */
function SpeedInfo({
  group,
  recalibrating,
  onRecalibrate,
}: {
  group: Group;
  recalibrating: boolean;
  onRecalibrate: () => void;
}) {
  const status = group.speedStatus;
  const p = group.speedProfile;

  if (status === "pending" || recalibrating) {
    return (
      <div className="hint speed-info">
        <span className="spinner" /> Testing model speeds&hellip; every model gets throttled to the slowest one
        found, so pace can&rsquo;t give the answer away. Can take up to 20s.
      </div>
    );
  }

  if (status === "error" && !p) {
    return (
      <div className="hint speed-info">
        Speed test failed{group.speedError ? `: ${group.speedError}` : ""}.{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onRecalibrate();
          }}
        >
          retry
        </a>
      </div>
    );
  }

  if (!p) {
    return (
      <div className="hint speed-info">
        Speed not tested yet.{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onRecalibrate();
          }}
        >
          test now
        </a>
      </div>
    );
  }

  return (
    <div className="hint speed-info">
      Throttled to this group&rsquo;s slowest model: {fmtMs(p.targetTtftMs)} to first token
      {p.targetTokensPerSecond ? `, ~${p.targetTokensPerSecond.toFixed(1)} tok/s cap` : ""} (measured max +25%).{" "}
      <a
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onRecalibrate();
        }}
      >
        recalibrate
      </a>
      <details className="foldout">
        <summary>per-model</summary>
        <div className="body code">
          {p.samples.map((s) => (
            <div key={s.modelId}>
              {s.modelId}:{" "}
              {s.ok
                ? `${fmtMs(s.ttftMs)} ttft${s.tokensPerSecond ? `, ${s.tokensPerSecond.toFixed(1)} tok/s` : ""}`
                : `failed (${s.error || "unknown"})`}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
