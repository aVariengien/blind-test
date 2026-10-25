import { useEffect, useMemo, useRef, useState } from "react";
import { deleteRoom, getRoom, guessRoom, listRooms, newRoom, sendRoomMessage, validateIds } from "../api";
import Markdownish from "./Markdownish";
import GuessAllModal from "./GuessAllModal";
import type { BlindParticipant, Group, Room as RoomT } from "../types";

// Cycled by participant index so each handle keeps a stable color for the
// life of the room, distinct from the human's own bubble style.
const PALETTE = ["#6b4fbb", "#2e7d52", "#b0651e", "#1f6fa8", "#a83e6b", "#5c7a1e", "#a83e3e", "#1e7a7a"];

const MAX_CASCADE_DEFAULT = 12;
const MAX_CASCADE_MIN = 1;
const MAX_CASCADE_MAX = 50;

export default function Room({ groups }: { groups: Group[] }) {
  const [groupId, setGroupId] = useState(() => groups[0]?.id || "");
  const [maxCascade, setMaxCascade] = useState(MAX_CASCADE_DEFAULT);
  const [rooms, setRooms] = useState<RoomT[]>([]);
  const [active, setActive] = useState<RoomT | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number>();

  useEffect(() => {
    if (!groupId && groups.length) setGroupId(groups[0].id);
  }, [groups, groupId]);

  useEffect(() => {
    listRooms()
      .then(setRooms)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.clearInterval(pollTimer.current);
    if (!active || !active.processing) return;
    pollTimer.current = window.setInterval(async () => {
      try {
        const fresh = await getRoom(active.id);
        setActive(fresh);
        if (!fresh.processing) {
          window.clearInterval(pollTimer.current);
          listRooms()
            .then(setRooms)
            .catch(() => undefined);
        }
      } catch {
        /* transient — try again next tick */
      }
    }, 1200);
    return () => window.clearInterval(pollTimer.current);
  }, [active?.id, active?.processing]);

  const group = groups.find((g) => g.id === groupId);

  async function create() {
    if (!group) return;
    setCreating(true);
    setError(null);
    try {
      const r = await newRoom(group.id, maxCascade);
      setActive(r);
      setRooms((all) => [r, ...all]);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setCreating(false);
    }
  }

  async function open(id: string) {
    try {
      setActive(await getRoom(id));
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this room?")) return;
    try {
      await deleteRoom(id);
      setRooms((all) => all.filter((r) => r.id !== id));
      if (active?.id === id) setActive(null);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="page wide">
      <h1>Room</h1>
      <div className="sub">
        A blind group chat: every model in a group joins as @model1, @model2, etc — which real model is which is
        hidden until you guess. Mention <span className="mono">@models</span> to address everyone, or a specific{" "}
        <span className="mono">@handle</span> to bring just them in. A model mentioning another participant's
        handle in its own reply brings that participant in too — including models mentioning each other.
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
          <button className="primary" disabled={creating || !group} onClick={create}>
            {creating ? <span className="spinner" /> : "New room"}
          </button>
        </div>

        <details className="foldout">
          <summary>room settings</summary>
          <div className="body room-settings">
            <label>
              max cascade replies per message
              <input
                type="number"
                min={MAX_CASCADE_MIN}
                max={MAX_CASCADE_MAX}
                value={maxCascade}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  setMaxCascade(Number.isFinite(n) ? Math.min(MAX_CASCADE_MAX, Math.max(MAX_CASCADE_MIN, n)) : MAX_CASCADE_DEFAULT);
                }}
              />
            </label>
            <div className="hint">
              Caps how many model replies one message you send can chain together via @mentions — including models
              mentioning each other, not just the ones you tag directly. Higher allows a longer back-and-forth
              between models; lower cuts a runaway mention chain short sooner. Set once, when the room is created.
            </div>
          </div>
        </details>
      </div>

      {rooms.length ? (
        <div className="compare-history">
          {rooms.map((r) => (
            <button
              key={r.id}
              className={`chip ok ${active?.id === r.id ? "on" : ""}`}
              onClick={() => open(r.id)}
              title={new Date(r.createdAt).toLocaleString()}
            >
              {r.groupName} · {r.participants.length}p · {r.messageCount}m
              {r.processing ? <span className="spinner" /> : r.revealed ? " · revealed" : null}
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
        <RoomView
          key={active.id}
          room={active}
          group={groups.find((g) => g.id === active.groupId)}
          onChange={setActive}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function RoomView({
  room,
  group,
  onChange,
  onError,
}: {
  room: RoomT;
  group?: Group;
  onChange: (r: RoomT) => void;
  onError: (e: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [guessOpen, setGuessOpen] = useState(false);
  const [guessing, setGuessing] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const ta = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const colorOf = useMemo(() => {
    const map: Record<string, string> = {};
    room.participants.forEach((p, i) => (map[p.handle] = PALETTE[i % PALETTE.length]));
    return map;
  }, [room.participants]);

  const guessByHandle = useMemo(() => {
    const map: Record<string, { correct: boolean; guessedModelId: string }> = {};
    room.guesses?.forEach((g) => (map[g.handle] = g));
    return map;
  }, [room.guesses]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [room.messages?.length]);

  // Real names for the guess picker — only worth fetching once you might
  // actually guess, and harmless pre-reveal since the group's line-up isn't
  // the secret, only which handle maps to which member of it is.
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

  function onDraftChange(v: string) {
    setDraft(v);
    const cursor = ta.current?.selectionStart ?? v.length;
    const upToCursor = v.slice(0, cursor);
    const m = upToCursor.match(/@([\w.-]*)$/);
    if (!m) return setSuggest([]);
    const q = m[1].toLowerCase();
    const options = ["models", ...room.participants.map((p) => p.handle)].filter((h) => h.toLowerCase().startsWith(q));
    setSuggest(q ? options.slice(0, 6) : []);
  }

  function insertMention(handle: string) {
    const el = ta.current;
    const cursor = el?.selectionStart ?? draft.length;
    const upToCursor = draft.slice(0, cursor);
    const m = upToCursor.match(/@([\w.-]*)$/);
    if (!m) return;
    const start = cursor - m[0].length;
    const next = `${draft.slice(0, start)}@${handle} ${draft.slice(cursor)}`;
    setDraft(next);
    setSuggest([]);
    requestAnimationFrame(() => el?.focus());
  }

  async function send() {
    const content = draft.trim();
    if (!content || sending || room.processing || room.revealed) return;
    setSending(true);
    try {
      onChange(await sendRoomMessage(room.id, content));
      setDraft("");
      setSuggest([]);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setSending(false);
    }
  }

  async function submitGuess(guesses: Record<string, string>) {
    setGuessing(true);
    try {
      onChange(await guessRoom(room.id, guesses));
      setGuessOpen(false);
    } catch (err) {
      onError(String(err instanceof Error ? err.message : err));
    } finally {
      setGuessing(false);
    }
  }

  const correctCount = room.guesses?.filter((g) => g.correct).length ?? 0;

  return (
    <div className="room-view">
      <div className="room-roster">
        {room.participants.map((p) => {
          const g = guessByHandle[p.handle];
          return (
            <span key={p.handle} className="room-roster-item">
              <span className="room-dot" style={{ background: colorOf[p.handle] }} />@{p.handle}
              {room.revealed ? <span className="nm">{participantLabel(p)}</span> : null}
              {g ? <span className={`room-guess-mark ${g.correct ? "right" : "wrong"}`}>{g.correct ? "✓" : "✗"}</span> : null}
            </span>
          );
        })}
        <span className="spacer" />
        {room.revealed ? (
          <span className="badge good">
            {correctCount}/{room.participants.length} correct
          </span>
        ) : (
          <button disabled={!group} onClick={() => setGuessOpen(true)}>
            Guess who's who
          </button>
        )}
      </div>
      <div className="room-rules">
        {room.rulesPrompt}
        <div className="room-cascade-cap">Cascade cap for this room: {room.maxCascade} model replies per message you send.</div>
      </div>

      <div className="room-thread" ref={scroller}>
        {(room.messages || []).map((m) => (
          <div key={m.id} className={`room-msg ${m.role}`}>
            <div className="who" style={m.role === "model" ? { color: colorOf[m.handle] } : undefined}>
              {m.role === "user" ? "you" : `@${m.handle}`}
              {m.role === "model" && room.revealed
                ? (() => {
                    const p = room.participants.find((x) => x.handle === m.handle);
                    return p ? <span className="room-meta"> · {participantLabel(p)}</span> : null;
                  })()
                : null}
              {m.role === "model" && m.meta?.totalMs ? (
                <span className="room-meta"> · {(m.meta.totalMs / 1000).toFixed(1)}s</span>
              ) : null}
            </div>
            {m.error ? (
              <div className="err">{m.error}</div>
            ) : (
              <div className="bubble">
                <Markdownish text={m.content} />
              </div>
            )}
          </div>
        ))}
        {room.processing ? (
          <div className="room-msg model pending">
            <div className="who">room</div>
            <div className="bubble">
              <span className="spinner" /> waiting on a reply…
            </div>
          </div>
        ) : null}
      </div>
      {room.error ? <div className="errbar">{room.error}</div> : null}

      {room.revealed ? (
        <div className="hint">Room revealed — guesses are locked in. Start a new room to play again.</div>
      ) : (
        <>
          <div className="room-composer">
            {suggest.length ? (
              <div className="suggest room-suggest">
                {suggest.map((h) => (
                  <div key={h} onMouseDown={() => insertMention(h)}>
                    @{h}
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              ref={ta}
              rows={2}
              placeholder="@models to address everyone, or @model1 for someone specific…"
              value={draft}
              disabled={room.processing}
              onChange={(e) => onDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="primary" disabled={sending || room.processing || !draft.trim()} onClick={send}>
              {sending ? <span className="spinner" /> : "Send"}
            </button>
          </div>
          {!draft.includes("@") ? <div className="hint">Nobody replies unless you @mention them.</div> : null}
        </>
      )}

      {guessOpen && group ? (
        <GuessAllModal
          participants={room.participants}
          candidateIds={group.modelIds}
          names={names}
          subtitle="One guess per handle. Submitting locks the room and reveals every model — the ones you can't tell apart from the models themselves."
          onCancel={() => setGuessOpen(false)}
          onSubmit={submitGuess}
        />
      ) : null}
      {guessing ? <div className="hint">Revealing…</div> : null}
    </div>
  );
}

function participantLabel(p: BlindParticipant): string {
  return p.modelName || p.modelId || "?";
}
