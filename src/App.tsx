import { useCallback, useEffect, useState } from "react";
import Chat from "./components/Chat";
import Groups from "./components/Groups";
import Stats from "./components/Stats";
import Compare from "./components/Compare";
import Room from "./components/Room";
import Playground from "./components/Playground";
import * as api from "./api";
import type { Group, LogEvent, Round } from "./types";

type Tab = "chat" | "playground" | "groups" | "stats" | "compare" | "room";
const LAST_GROUP = "blind-test.lastGroup";
const DETAILS = "blind-test.details";
const TABS: Tab[] = ["chat", "playground", "stats", "compare", "room", "groups"];
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace(/^#\/?/, "") as Tab;
  return TABS.includes(h) ? h : "playground";
};
const MAX_EVENTS = 4000;

export default function App() {
  const [status, setStatus] = useState<{ hasKey: boolean; keySource: string; hasOpenAiKey: boolean } | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const [groupId, setGroupId] = useState<string>(() => localStorage.getItem(LAST_GROUP) || "");
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [verbose, setVerbose] = useState(false);
  // Instrumentation is opt-in: the default read is just the conversation.
  const [details, setDetails] = useState(() => localStorage.getItem(DETAILS) === "1");
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pushEvent = useCallback((e: LogEvent) => {
    setEvents((all) => (all.length > MAX_EVENTS ? [...all.slice(-MAX_EVENTS + 1), e] : [...all, e]));
  }, []);

  const refreshRounds = useCallback(async () => {
    try {
      setRounds(await api.listRounds());
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Boot: key status, groups, round history. Resume the newest open round.
  useEffect(() => {
    (async () => {
      try {
        const [st, gs, rs] = await Promise.all([api.getStatus(), api.getGroups(), api.listRounds()]);
        setStatus(st);
        setGroups(gs);
        setRounds(rs);
        if (!gs.length) setTab("groups");
        // Pick up where you left off: the newest round, finished or not, so a
        // refresh does not swallow the reveal you were still looking at.
        const latest = rs[rs.length - 1];
        if (latest) {
          setRound(await api.getRound(latest.id));
          setGroupId(gs.some((x) => x.id === latest.groupId) ? latest.groupId : gs[0]?.id || "");
        } else if (gs.length) {
          setGroupId((g) => (gs.some((x) => x.id === g) ? g : gs[0].id));
        }
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
      }
    })();
  }, []);

  useEffect(() => {
    if (groupId) localStorage.setItem(LAST_GROUP, groupId);
  }, [groupId]);

  useEffect(() => {
    localStorage.setItem(DETAILS, details ? "1" : "0");
  }, [details]);

  // Tabs live in the hash so a refresh (and the back button) keep your place.
  useEffect(() => {
    if (tabFromHash() !== tab) window.location.hash = `#/${tab}`;
  }, [tab]);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Pretty names for the guess picker, straight from the OpenRouter catalogue.
  useEffect(() => {
    const ids = round?.modelIds ?? groups.find((g) => g.id === groupId)?.modelIds ?? [];
    if (!ids.length) return;
    let dead = false;
    api
      .validateIds(ids)
      .then((res) => {
        if (dead) return;
        const map: Record<string, string> = {};
        for (const r of res) if (r.name) map[r.id] = r.name;
        setNames((prev) => ({ ...prev, ...map }));
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [round?.id, groupId, groups]);

  async function startRound() {
    const gid = round && !round.revealed ? "" : groupId;
    if (!gid) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.newRound(gid);
      setEvents([{ t: Date.now(), kind: "round", detail: `#${r.seq} drawn from ${r.groupName}` }]);
      setRound(r);
      setTab("chat");
      refreshRounds();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  async function reloadRound() {
    if (!round) return;
    try {
      setRound(await api.getRound(round.id));
      refreshRounds();
    } catch (err) {
      setError(String(err));
    }
  }

  async function openRound(id: string) {
    try {
      setRound(await api.getRound(id));
      setEvents([]);
      setTab("chat");
    } catch (err) {
      setError(String(err));
    }
  }

  async function removeRound(id: string) {
    try {
      await api.deleteRound(id);
      if (round?.id === id) setRound(null);
      refreshRounds();
    } catch (err) {
      setError(String(err));
    }
  }

  const liveRound = round && !round.revealed;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          blind test
        </div>

        <div className="tabs">
          {TABS.map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        <span className="spacer" />

        <button
          className={`toggle ${details ? "on" : ""}`}
          onClick={() => setDetails(!details)}
          title={details ? "hide the event log and message metadata" : "show the event log and message metadata"}
        >
          details
        </button>

        {round ? (
          <span className={`badge ${liveRound ? "live" : round.correct ? "good" : "bad"}`}>
            round #{round.seq} · {round.revealed ? (round.correct ? "correct" : "wrong") : `${round.userMessageCount}q`}
          </span>
        ) : null}

        <label>
          group
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} disabled={Boolean(liveRound)}>
            {groups.length === 0 ? <option value="">(none yet)</option> : null}
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.modelIds.length})
              </option>
            ))}
          </select>
        </label>

        <button
          className="primary"
          onClick={startRound}
          disabled={busy || !groupId || Boolean(liveRound)}
          title={liveRound ? "finish this round with a guess first" : "draw a new secret model"}
        >
          {busy ? <span className="spinner" /> : "New round"}
        </button>
      </header>

      {status && !status.hasKey ? (
        <div className="errbar" style={{ margin: "10px 14px" }}>
          No OPENROUTER_API_KEY on the server. Export it in your shell (or drop it in a .env file next to the
          Makefile) and restart with `make`.
        </div>
      ) : null}
      {status && status.hasKey && !status.hasOpenAiKey && tab === "compare" ? (
        <div className="errbar" style={{ margin: "10px 14px" }}>
          No OPENAI_API_KEY on the server — responses will run and show side by side, but without
          distance-ranking. Export it alongside OPENROUTER_API_KEY and restart with `make` to enable it.
        </div>
      ) : null}
      {error ? (
        <div className="errbar" style={{ margin: "10px 14px" }}>
          {error}
          <button className="ghost tiny" style={{ marginLeft: 8 }} onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      ) : null}

      <div className="main">
        {tab === "chat" ? (
          round ? (
            <Chat
              key={`${round.id}:${round.revealed}`}
              round={round}
              names={names}
              onRoundChange={reloadRound}
              onNewRound={startRound}
              events={events}
              pushEvent={pushEvent}
              clearEvents={() => setEvents([])}
              verbose={verbose}
              setVerbose={setVerbose}
              details={details}
            />
          ) : (
            <div className="welcome">
              <h1>blind test</h1>
              <p>
                A random model from the group you choose sits on the other side of the chat. Talk to it, then guess
                who it was.
              </p>
              <p className="hint">
                {groups.length
                  ? "Pick a group up top and hit New round."
                  : "Start by defining a group of models on the groups tab."}
              </p>
            </div>
          )
        ) : tab === "playground" ? (
          <Playground groups={groups} details={details} />
        ) : tab === "groups" ? (
          <div className="col scroll">
            <Groups
              groups={groups}
              onChange={(g) => {
                setGroups(g);
                if (!g.some((x) => x.id === groupId)) setGroupId(g[0]?.id || "");
              }}
            />
          </div>
        ) : tab === "compare" ? (
          <div className="col scroll">
            <Compare groups={groups} />
          </div>
        ) : tab === "room" ? (
          <div className="col scroll">
            <Room groups={groups} />
          </div>
        ) : (
          <div className="col scroll">
            <Stats rounds={rounds} onOpenRound={openRound} onDeleteRound={removeRound} />
          </div>
        )}
      </div>
    </div>
  );
}
