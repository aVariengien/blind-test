import { useEffect, useRef, useState } from "react";
import Message from "./Message";
import Inspector from "./Inspector";
import GuessModal from "./GuessModal";
import { getRawLog, streamMessage, submitGuess, updateSettings } from "../api";
import type { ChatMessage, LogEvent, Round } from "../types";

const TMP_ASSISTANT = "tmp-assistant";

export default function Chat({
  round,
  names,
  onRoundChange,
  onNewRound,
  events,
  pushEvent,
  clearEvents,
  verbose,
  setVerbose,
  details,
}: {
  round: Round;
  names: Record<string, string>;
  onRoundChange: () => void;
  onNewRound: () => void;
  events: LogEvent[];
  pushEvent: (e: LogEvent) => void;
  clearEvents: () => void;
  verbose: boolean;
  setVerbose: (v: boolean) => void;
  details: boolean;
}) {
  const [msgs, setMsgs] = useState<ChatMessage[]>(round.messages || []);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guessOpen, setGuessOpen] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const [settings, setSettings] = useState(round.settings);
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  // Follow the stream only while you are already parked at the bottom. Scroll up
  // mid-generation and the view stays exactly where you left it.
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const lastPin = useRef(0);
  const trailingPin = useRef<number>();

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (near !== stick.current) {
      stick.current = near;
      setAtBottom(near);
    }
  }

  function jumpToLatest() {
    // Instant, not smooth: a smooth scroll fires intermediate scroll events that
    // read as "not at the bottom" and would cancel the jump it just started.
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
    lastPin.current = Date.now();
  }

  function pinNow() {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    lastPin.current = Date.now();
  }

  useEffect(() => {
    if (!stick.current) return;
    if (!streaming) return pinNow();
    // The group's speed throttle deliberately drips a reply out as many small
    // deltas a second, each of which lands here — re-pinning on every single
    // one never leaves a gap for a scroll-up gesture to register before the
    // next delta snaps it back. Coalesce to a fixed cadence instead: pin
    // right away if it's been a while, otherwise schedule one trailing pin.
    const elapsed = Date.now() - lastPin.current;
    if (elapsed >= 150) {
      pinNow();
    } else if (trailingPin.current === undefined) {
      trailingPin.current = window.setTimeout(() => {
        trailingPin.current = undefined;
        if (stick.current) pinNow();
      }, 150 - elapsed);
    }
  }, [msgs, streaming]);

  useEffect(() => () => window.clearTimeout(trailingPin.current), []);

  useEffect(() => {
    if (!round.revealed) ta.current?.focus();
  }, [round.revealed]);

  const shown = verbose ? events : events.filter((e) => e.kind !== "delta" && e.kind !== "reasoning");

  function patchAssistant(fn: (m: ChatMessage) => ChatMessage) {
    setMsgs((all) => all.map((m) => (m.id === TMP_ASSISTANT ? fn(m) : m)));
  }

  async function send(content?: string, retry = false) {
    if (streaming || round.revealed) return;
    setError(null);
    setStreaming(true);
    stick.current = true;
    setAtBottom(true);
    if (!retry && content) {
      setMsgs((all) => [
        ...all.filter((m) => m.id !== TMP_ASSISTANT || m.content || m.meta?.error),
        { id: `tmp-user-${Date.now()}`, role: "user", content, createdAt: Date.now() },
      ]);
      pushEvent({ t: Date.now(), kind: "send", detail: `${content.length} chars` });
    } else {
      pushEvent({ t: Date.now(), kind: "retry", detail: "resending last turn" });
    }
    setMsgs((all) => [
      ...all,
      { id: TMP_ASSISTANT, role: "assistant", content: "", createdAt: Date.now(), pending: true, meta: {} },
    ]);

    try {
      await streamMessage(round.id, retry ? { retry: true } : { content }, (evt) => {
        switch (evt.type) {
          case "start":
            pushEvent({ t: Date.now(), kind: "start", detail: "request sent to openrouter" });
            break;
          case "first_token":
            pushEvent({ t: Date.now(), kind: "first_token", detail: `${evt.ms}ms (${evt.kind})`, tone: "muted" });
            break;
          case "delta":
            pushEvent({ t: Date.now(), kind: "delta", detail: JSON.stringify(evt.text), tone: "muted" });
            patchAssistant((m) => ({ ...m, content: m.content + evt.text }));
            break;
          case "reasoning":
            pushEvent({ t: Date.now(), kind: "reasoning", detail: JSON.stringify(evt.text), tone: "think" });
            patchAssistant((m) => ({ ...m, reasoning: (m.reasoning || "") + evt.text }));
            break;
          case "reasoning_details":
            pushEvent({ t: Date.now(), kind: "reasoning_details", detail: `+${evt.count}`, tone: "think" });
            break;
          case "tool_call":
            pushEvent({
              t: Date.now(),
              kind: "tool_call",
              detail: `#${evt.index} ${evt.name || "?"} ${evt.argumentsDelta || ""}`.trim(),
              tone: "tool",
            });
            patchAssistant((m) => {
              const calls = [...(m.toolCalls || [])];
              const slot = calls[evt.index] || { id: evt.id, type: "function", function: { name: "", arguments: "" } };
              calls[evt.index] = {
                ...slot,
                id: evt.id || slot.id,
                function: { name: evt.name || slot.function.name, arguments: slot.function.arguments + (evt.argumentsDelta || "") },
              };
              return { ...m, toolCalls: calls };
            });
            break;
          case "annotations":
            pushEvent({ t: Date.now(), kind: "annotations", detail: `+${evt.count}`, tone: "tool" });
            break;
          case "finish":
            pushEvent({
              t: Date.now(),
              kind: "finish",
              detail: `${evt.finishReason}${evt.nativeFinishReason ? ` / ${evt.nativeFinishReason}` : ""}`,
            });
            break;
          case "usage":
            pushEvent({ t: Date.now(), kind: "usage", detail: JSON.stringify(evt.usage) });
            break;
          case "error":
            pushEvent({ t: Date.now(), kind: "error", detail: String(evt.message), tone: "warn" });
            setError(String(evt.message));
            break;
          case "done":
            pushEvent({
              t: Date.now(),
              kind: "done",
              detail: `${evt.message?.content?.length || 0} chars in ${evt.message?.meta?.totalMs ?? "?"}ms`,
            });
            if (evt.message) {
              setMsgs((all) => all.map((m) => (m.id === TMP_ASSISTANT ? { ...evt.message, pending: false } : m)));
            } else {
              setMsgs((all) => all.filter((m) => m.id !== TMP_ASSISTANT));
            }
            // The round prop held by the parent is otherwise only refreshed on
            // guess — sync it after every turn too, so it never drifts far
            // behind what's actually saved. msgs here is local state and
            // un-touched by this; it's purely so a remount (hot-reload, a
            // future refactor, StrictMode, ...) has a fresh transcript to
            // re-initialize from instead of a stale one from round-open time.
            onRoundChange();
            break;
          default:
            pushEvent({ t: Date.now(), kind: evt.type || "?", detail: JSON.stringify(evt).slice(0, 300) });
        }
      });
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      pushEvent({ t: Date.now(), kind: "error", detail: msg, tone: "warn" });
      setError(msg);
      setMsgs((all) => all.filter((m) => m.id !== TMP_ASSISTANT || m.content));
    } finally {
      setStreaming(false);
      patchAssistant((m) => ({ ...m, pending: false }));
    }
  }

  async function doGuess(id: string) {
    setGuessOpen(false);
    try {
      const r = await submitGuess(round.id, id);
      pushEvent({
        t: Date.now(),
        kind: "guess",
        detail: `${id} → ${r.correct ? "correct" : `wrong, it was ${r.actualModel}`}`,
        tone: r.correct ? undefined : "warn",
      });
      onRoundChange();
    } catch (err) {
      setError(String(err));
    }
  }

  async function changeSetting(patch: Partial<Round["settings"]>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await updateSettings(round.id, patch);
      pushEvent({ t: Date.now(), kind: "settings", detail: JSON.stringify(patch), tone: "muted" });
    } catch {
      /* non-fatal */
    }
  }

  const lastMsg = msgs[msgs.length - 1];
  const canRetry = !streaming && !round.revealed && lastMsg?.role === "user";

  return (
    <>
      <div className="col">
        <div className="scrollwrap">
        <div className="scroll" ref={scroller} onScroll={onScroll}>
          <div className="thread">
            {msgs.length === 0 ? (
              <div className="hint" style={{ fontFamily: "var(--serif)", fontSize: 18 }}>
                Round {round.seq} is live. One of {round.modelIds.length} models from{" "}
                <b>{round.groupName}</b> is on the other end. Ask it anything.
              </div>
            ) : null}

            {msgs.map((m) => (
              <Message key={m.id} msg={m} revealed={round.revealed} details={details} />
            ))}

            {round.revealed ? (
              <div className={`reveal ${round.correct ? "right" : "wrong"}`}>
                <div className="verdict">{round.correct ? "Correct." : "Wrong."}</div>
                <div className="line">
                  You guessed <b>{round.guess}</b>
                </div>
                <div className="line">
                  It was <b>{round.actualModel}</b>
                  {round.actualModelName ? ` — ${round.actualModelName}` : ""}
                </div>
                <div className="line" style={{ color: "var(--muted)" }}>
                  {round.userMessageCount} question{round.userMessageCount === 1 ? "" : "s"} · group {round.groupName}
                </div>
                <div className="actions">
                  <button className="primary" onClick={onNewRound}>
                    New round
                  </button>
                  <button onClick={openRaw}>View raw log</button>
                </div>
              </div>
            ) : null}

            {error ? <div className="errbar">{error}</div> : null}
          </div>
        </div>

        {!atBottom && msgs.length ? (
            <button className="jump-latest" onClick={jumpToLatest}>
              {streaming ? "still writing" : "latest"} &darr;
            </button>
          ) : null}
        </div>

        <div className="composer">
          {round.revealed ? (
            <div className="row">
              <div className="meta" style={{ flex: 1 }}>
                Round {round.seq} is closed. Start a new one to keep playing.
              </div>
              <button className="primary" onClick={onNewRound}>
                New round
              </button>
            </div>
          ) : (
            <>
              <div className="row">
                <textarea
                  ref={ta}
                  value={draft}
                  placeholder="Probe it…  (⌘/Ctrl+Enter to send)"
                  onChange={(e) => {
                    setDraft(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`;
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (draft.trim()) {
                        send(draft.trim());
                        setDraft("");
                        if (ta.current) ta.current.style.height = "auto";
                      }
                    }
                  }}
                />
                <button
                  className="primary"
                  disabled={streaming || !draft.trim()}
                  onClick={() => {
                    send(draft.trim());
                    setDraft("");
                    if (ta.current) ta.current.style.height = "auto";
                  }}
                >
                  {streaming ? <span className="spinner" /> : "Send"}
                </button>
                <button disabled={streaming || msgs.length === 0} onClick={() => setGuessOpen(true)}>
                  Guess
                </button>
              </div>
              <div className="meta">
                <label>
                  temp
                  <input
                    className="num"
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={settings.temperature}
                    onChange={(e) => changeSetting({ temperature: Number(e.target.value) })}
                  />
                </label>
                <label>
                  max tokens
                  <input
                    className="num"
                    type="number"
                    step="100"
                    min="16"
                    value={settings.maxTokens}
                    onChange={(e) => changeSetting({ maxTokens: Number(e.target.value) })}
                  />
                </label>
                <label>
                  reasoning
                  <select
                    value={settings.reasoning}
                    onChange={(e) => changeSetting({ reasoning: e.target.value as Round["settings"]["reasoning"] })}
                  >
                    <option value="auto">auto</option>
                    <option value="off">off</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
                {canRetry ? (
                  <button className="tiny" onClick={() => send(undefined, true)}>
                    retry last turn
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      {details ? (
        <Inspector
          events={shown}
          onClear={clearEvents}
          onOpenRaw={openRaw}
          rawAvailable={round.revealed}
          verbose={verbose}
          setVerbose={setVerbose}
        />
      ) : null}

      {guessOpen ? (
        <GuessModal
          modelIds={round.modelIds}
          names={names}
          onCancel={() => setGuessOpen(false)}
          onSubmit={doGuess}
        />
      ) : null}

      {raw !== null ? (
        <div className="modal-bg" onClick={() => setRaw(null)}>
          <div className="modal" style={{ width: 900 }} onClick={(e) => e.stopPropagation()}>
            <h2>Raw round log</h2>
            <div className="hint mono">data/logs/{round.id}.jsonl</div>
            <pre
              className="mono"
              style={{
                maxHeight: "62vh",
                overflow: "auto",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 10,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {raw || "(empty)"}
            </pre>
            <div className="actions">
              <button onClick={() => navigator.clipboard?.writeText(raw)}>Copy</button>
              <button className="primary" onClick={() => setRaw(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );

  async function openRaw() {
    try {
      setRaw(await getRawLog(round.id));
    } catch (err) {
      setError(`raw log: ${err}`);
    }
  }
}
