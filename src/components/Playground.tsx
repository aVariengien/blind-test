import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Message from "./Message";
import Inspector from "./Inspector";
import CommentMargin from "./CommentMargin";
import BranchTree from "./BranchTree";
import {
  deleteChat,
  getChat,
  getChatLog,
  listChats,
  newChat,
  searchCatalog,
  setChatHead,
  streamChat,
  updateChatConfig,
} from "../api";
import ProviderPicker from "./ProviderPicker";
import { conversationToMarkdown, copyRich } from "../exportMarkdown";
import { buildTree, leafUnder, pathTo, siblingsOf } from "../tree";
import type { ChatComment, ChatMessage, Group, LogEvent, PlaygroundChat, RoundSettings } from "../types";

const TMP_ASSISTANT = "tmp-assistant";
const ACTIVE = "blind-test.playground.chat";
// The config a brand-new chat starts from: whatever you last used.
const DRAFT = "blind-test.playground.draft";
const TREE = "blind-test.playground.tree";
// Unsent composer text, one key per chat ("new" before the first send), so it survives closing the tab.
const COMPOSER = "blind-test.playground.composer";
const composerKey = (chatId: string | null) => `${COMPOSER}.${chatId ?? "new"}`;
const MAX_EVENTS = 4000;

type Config = { modelId: string; systemPrompt: string; settings: RoundSettings };
const DEFAULT_CONFIG: Config = {
  modelId: "",
  systemPrompt: "",
  settings: { temperature: 1, maxTokens: 4000, reasoning: "auto" },
};

function loadDraft(): Config {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) || "null");
    if (d) return { ...DEFAULT_CONFIG, ...d, settings: { ...DEFAULT_CONFIG.settings, ...d.settings } };
  } catch {
    /* fall through */
  }
  return DEFAULT_CONFIG;
}

function loadComposer(chatId: string | null): string {
  try {
    return localStorage.getItem(composerKey(chatId)) || "";
  } catch {
    return "";
  }
}

function saveComposer(chatId: string | null, text: string) {
  try {
    if (text) localStorage.setItem(composerKey(chatId), text);
    else localStorage.removeItem(composerKey(chatId));
  } catch {
    /* storage full or blocked — the draft just won't persist */
  }
}

const configOf = (c: PlaygroundChat): Config => ({ modelId: c.modelId, systemPrompt: c.systemPrompt, settings: c.settings });

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

export default function Playground({ groups, details }: { groups: Group[]; details: boolean }) {
  const [chats, setChats] = useState<PlaygroundChat[]>([]);
  const [chatId, setChatId] = useState<string | null>(() => localStorage.getItem(ACTIVE));
  // Every message on every branch; `head` is the last one of the branch on screen.
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [treeOpen, setTreeOpen] = useState(() => localStorage.getItem(TREE) === "1");
  const pendingScroll = useRef<string | null>(null);
  const [comments, setComments] = useState<ChatComment[]>([]);
  const doc = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<Config>(loadDraft);
  const [promptOpen, setPromptOpen] = useState(false);
  // Per chat, saved with it: fold thinking away instead of showing it inline.
  const [collapseThinking, setCollapseThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  // Set by Escape, so the blur that follows doesn't save what it just threw away.
  const renameCancelled = useRef(false);
  const [draft, setDraft] = useState(() => loadComposer(localStorage.getItem(ACTIVE)));
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [verbose, setVerbose] = useState(false);
  const [raw, setRaw] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  // A chat created by the first send is already on screen mid-stream — don't
  // let the open-chat effect below overwrite it with the half-saved copy.
  const justCreated = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  // Scrolling is yours: the view only jumps to the bottom when a chat opens or you send.
  const pinOnce = useRef(true);
  // The streaming reply's id: a placeholder until the server hands out the real one.
  const liveId = useRef(TMP_ASSISTANT);

  const groupModels = useMemo(() => [...new Set(groups.flatMap((g) => g.modelIds))], [groups]);
  const tree = useMemo(() => buildTree(msgs), [msgs]);
  const path = useMemo(() => pathTo(tree, head), [tree, head]);
  const noteCounts = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of comments) n.set(c.messageId, (n.get(c.messageId) || 0) + 1);
    return n;
  }, [comments]);

  useEffect(() => {
    localStorage.setItem(TREE, treeOpen ? "1" : "0");
  }, [treeOpen]);

  /** Take whatever the server saved as the truth: all branches, current head, notes. */
  function adopt(c: PlaygroundChat) {
    setMsgs(c.messages || []);
    setHead(c.headId ?? null);
    setComments(c.comments ?? []);
    setCollapseThinking(Boolean(c.collapseThinking));
  }

  function pushEvent(e: LogEvent) {
    setEvents((all) => (all.length > MAX_EVENTS ? [...all.slice(-MAX_EVENTS + 1), e] : [...all, e]));
  }

  const refreshList = () =>
    listChats()
      .then(setChats)
      .catch(() => undefined);

  useEffect(() => {
    refreshList();
  }, []);

  // Open (or re-open after a refresh) the active chat.
  useEffect(() => {
    if (chatId) localStorage.setItem(ACTIVE, chatId);
    else localStorage.removeItem(ACTIVE);
    // The send that created this chat already cleared the composer; don't clobber anything typed since.
    if (chatId !== justCreated.current) setDraft(loadComposer(chatId));
    setEditing(null);
    if (!chatId) {
      setMsgs([]);
      setHead(null);
      setComments([]);
      setCollapseThinking(false);
      return;
    }
    if (chatId === justCreated.current) return;
    let dead = false;
    getChat(chatId)
      .then((c) => {
        if (dead) return;
        pinOnce.current = true;
        adopt(c);
        setConfig(configOf(c));
        setPromptOpen(false);
      })
      .catch(() => !dead && setChatId(null));
    return () => {
      dead = true;
    };
  }, [chatId]);

  useEffect(() => {
    localStorage.setItem(DRAFT, JSON.stringify(config));
  }, [config]);

  // Fit the composer to its text, including text restored from storage.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    if (draft) el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

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
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
  }

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Jumped to a turn from the tree or a ‹ › switch: show that turn, not the bottom.
    if (pendingScroll.current) {
      const target = el.querySelector(`[data-msg-id="${CSS.escape(pendingScroll.current)}"]`);
      pendingScroll.current = null;
      target?.closest(".msg")?.scrollIntoView({ block: "center" });
      return;
    }
    if (!pinOnce.current) return;
    pinOnce.current = false;
    el.scrollTop = el.scrollHeight;
  }, [msgs, head]);

  /** Show the branch through `id`, following its most recent line down to the end. */
  function pick(id: string) {
    if (streaming || !chatId) return;
    const leaf = leafUnder(tree, id);
    setEditing(null);
    pendingScroll.current = id;
    stick.current = false;
    setHead(leaf);
    if (leaf !== head) {
      pushEvent({ t: Date.now(), kind: "branch", detail: `switched to ${leaf}`, tone: "muted" });
      setChatHead(chatId, leaf).catch((err) => setError(String(err instanceof Error ? err.message : err)));
    }
  }

  /** Persist a config change on the open chat right away (new chats pick it up on first send). */
  async function changeConfig(patch: Partial<Config>) {
    const next = { ...config, ...patch };
    setConfig(next);
    if (!chatId) return;
    try {
      const c = await updateChatConfig(chatId, patch);
      pushEvent({ t: Date.now(), kind: "config", detail: JSON.stringify(patch).slice(0, 300), tone: "muted" });
      setChats((all) => all.map((x) => (x.id === c.id ? { ...x, ...configOf(c) } : x)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function toggleThinking() {
    const next = !collapseThinking;
    setCollapseThinking(next);
    if (!chatId) return;
    try {
      await updateChatConfig(chatId, { collapseThinking: next });
      pushEvent({ t: Date.now(), kind: "config", detail: JSON.stringify({ collapseThinking: next }), tone: "muted" });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function copyMarkdown() {
    const { markdown, html } = conversationToMarkdown({
      title: chats.find((c) => c.id === chatId)?.title || "",
      modelId: config.modelId,
      systemPrompt: config.systemPrompt,
      path,
      comments,
    });
    try {
      await copyRich(markdown, html);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(`copy: ${err instanceof Error ? err.message : err}`);
    }
  }

  function patchAssistant(fn: (m: ChatMessage) => ChatMessage) {
    const id = liveId.current;
    setMsgs((all) => all.map((m) => (m.id === id ? fn(m) : m)));
  }

  /** Swap the optimistic placeholders for the ids the server just assigned. */
  function adoptIds(ids: Record<string, string>) {
    const swap = (id: string | null | undefined) => (id && ids[id]) || id;
    setMsgs((all) => all.map((m) => ({ ...m, id: swap(m.id)!, parentId: swap(m.parentId) })));
    setHead((h) => swap(h) ?? null);
  }

  /**
   * Plain send continues the current branch. `parentId` sends as a sibling of
   * the message being edited; `regenerate` re-rolls a reply as a sibling;
   * `retry` answers the branch's last message again. Nothing is ever deleted.
   */
  async function send(content?: string, opts: { parentId?: string | null; regenerate?: string; retry?: boolean } = {}) {
    if (streaming) return;
    if (!config.modelId) return setError("Pick a model first.");
    setError(null);
    setStreaming(true);
    pinOnce.current = true;
    liveId.current = TMP_ASSISTANT;

    let id = chatId;
    try {
      if (!id) {
        const c = await newChat({ ...config, collapseThinking });
        id = c.id;
        justCreated.current = id;
        setComments([]);
        setChats((all) => [c, ...all]);
        setChatId(id);
        setEvents([{ t: Date.now(), kind: "chat", detail: `new chat with ${c.modelId}` }]);
      }
    } catch (err) {
      setStreaming(false);
      return setError(String(err instanceof Error ? err.message : err));
    }

    // Optimistic copies, hung where the server will put the real ones.
    const reroll = Boolean(opts.regenerate || opts.retry);
    const edit = Object.prototype.hasOwnProperty.call(opts, "parentId");
    const optimistic: ChatMessage[] = [];
    let replyParent: string | null = null;
    if (reroll) {
      const target = opts.regenerate ? tree.byId.get(opts.regenerate) : path[path.length - 1];
      replyParent = target ? (target.role === "user" ? target.id : (target.parentId ?? null)) : null;
      pushEvent({ t: Date.now(), kind: opts.regenerate ? "regenerate" : "retry", detail: "new reply as a sibling branch" });
    } else if (content) {
      const tmpUser = `tmp-user-${Date.now()}`;
      optimistic.push({
        id: tmpUser,
        parentId: edit ? (opts.parentId ?? null) : head,
        role: "user",
        content,
        createdAt: Date.now(),
      });
      replyParent = tmpUser;
      pushEvent({
        t: Date.now(),
        kind: edit ? "edit" : "send",
        detail: `${content.length} chars → ${config.modelId}${edit ? " (new branch)" : ""}`,
      });
    }
    setMsgs((all) => [
      ...all,
      ...optimistic,
      {
        id: TMP_ASSISTANT,
        parentId: replyParent,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        pending: true,
        meta: { modelId: config.modelId, requestedModel: config.modelId, systemPrompt: config.systemPrompt },
      },
    ]);
    setHead(TMP_ASSISTANT);

    const ctl = new AbortController();
    abort.current = ctl;
    try {
      await streamChat(
        id!,
        {
          ...config,
          ...(opts.regenerate
            ? { regenerate: opts.regenerate }
            : opts.retry
              ? { retry: true }
              : { content, ...(edit ? { parentId: opts.parentId ?? null } : {}) }),
        },
        (evt) => {
          switch (evt.type) {
            case "start":
              pushEvent({ t: Date.now(), kind: "start", detail: "request sent to openrouter" });
              if (evt.assistantMessageId) {
                const ids: Record<string, string> = { [TMP_ASSISTANT]: evt.assistantMessageId };
                const tmpUser = optimistic[0]?.id;
                if (tmpUser && evt.userMessageId) ids[tmpUser] = evt.userMessageId;
                adoptIds(ids);
                liveId.current = evt.assistantMessageId;
              }
              break;
            case "first_token":
              pushEvent({ t: Date.now(), kind: "first_token", detail: `${evt.ms}ms (${evt.kind})`, tone: "muted" });
              patchAssistant((m) => ({ ...m, meta: { ...m.meta, firstTokenMs: evt.ms } }));
              break;
            case "delta":
              pushEvent({ t: Date.now(), kind: "delta", detail: JSON.stringify(evt.text), tone: "muted" });
              patchAssistant((m) => ({ ...m, content: m.content + evt.text }));
              break;
            case "reasoning":
              pushEvent({ t: Date.now(), kind: "reasoning", detail: JSON.stringify(evt.text), tone: "think" });
              patchAssistant((m) => ({ ...m, reasoning: (m.reasoning || "") + evt.text }));
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
                  function: {
                    name: evt.name || slot.function.name,
                    arguments: slot.function.arguments + (evt.argumentsDelta || ""),
                  },
                };
                return { ...m, toolCalls: calls };
              });
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
              break;
            case "done":
              pushEvent({
                t: Date.now(),
                kind: "done",
                detail: `${evt.message?.content?.length || 0} chars in ${evt.message?.meta?.totalMs ?? "?"}ms`,
              });
              patchAssistant((m) => ({ ...m, pending: false }));
              if (evt.chat) setChats((all) => [evt.chat, ...all.filter((x) => x.id !== evt.chat.id)]);
              // Swap the optimistic copies for the saved ones (real ids, real
              // parents), so the new turns can be commented on and branched from.
              getChat(id!)
                .then(adopt)
                .catch(() => undefined);
              break;
            default:
              pushEvent({ t: Date.now(), kind: evt.type || "?", detail: JSON.stringify(evt).slice(0, 300) });
          }
        },
        ctl.signal,
      );
    } catch (err) {
      if (ctl.signal.aborted) {
        pushEvent({ t: Date.now(), kind: "stopped", detail: "you stopped the stream", tone: "warn" });
      } else {
        const msg = String(err instanceof Error ? err.message : err);
        pushEvent({ t: Date.now(), kind: "error", detail: msg, tone: "warn" });
        setError(msg);
      }
      // Whatever the server kept is the truth — reload it.
      getChat(id!)
        .then(adopt)
        .catch(() => setMsgs((all) => all.filter((m) => m.id !== liveId.current || m.content)));
      refreshList();
    } finally {
      abort.current = null;
      setStreaming(false);
      patchAssistant((m) => ({ ...m, pending: false }));
    }
  }

  function submitEdit(m: ChatMessage) {
    const text = editing?.text.trim();
    if (!text || streaming) return;
    setEditing(null);
    send(text, { parentId: m.parentId ?? null });
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft("");
    saveComposer(chatId, "");
  }

  async function rename() {
    if (!renaming || renameCancelled.current) return;
    const { id, text } = renaming;
    setRenaming(null);
    const title = text.trim();
    if (!title || title === chats.find((c) => c.id === id)?.title) return;
    try {
      const c = await updateChatConfig(id, { title });
      setChats((all) => all.map((x) => (x.id === c.id ? { ...x, title: c.title } : x)));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this chat and its raw log?")) return;
    try {
      await deleteChat(id);
      saveComposer(id, "");
      setChats((all) => all.filter((c) => c.id !== id));
      if (id === chatId) setChatId(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function openRaw() {
    if (!chatId) return;
    try {
      setRaw(await getChatLog(chatId));
    } catch (err) {
      setError(`raw log: ${err}`);
    }
  }

  function startNew() {
    if (streaming) return;
    setChatId(null);
    setEvents([]);
    setError(null);
    setPromptOpen(!config.systemPrompt);
    ta.current?.focus();
  }

  const shown = verbose ? events : events.filter((e) => e.kind !== "delta" && e.kind !== "reasoning");
  const last = path[path.length - 1];
  const canRetry = !streaming && Boolean(last);

  // A small marker wherever the model or system prompt differs from the
  // previous reply's, since both can change mid-chat.
  let prevModel: string | undefined;
  let prevPrompt: string | undefined;

  return (
    <>
      <aside className="pg-list">
        <div className="head">
          <button className="primary" onClick={startNew} disabled={streaming}>
            New chat
          </button>
        </div>
        <div className="items">
          {chats.length === 0 ? <div className="hint">Chats you start show up here.</div> : null}
          {chats.map((c) => (
            <div
              key={c.id}
              className={`item ${c.id === chatId ? "on" : ""}`}
              onClick={() => !streaming && c.id !== chatId && (setEvents([]), setError(null), setChatId(c.id))}
            >
              {renaming?.id === c.id ? (
                <input
                  className="t rename"
                  autoFocus
                  value={renaming.text}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => {
                    renameCancelled.current = false;
                    e.target.select();
                  }}
                  onChange={(e) => setRenaming({ id: c.id, text: e.target.value })}
                  onBlur={rename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") {
                      renameCancelled.current = true;
                      setRenaming(null);
                    }
                  }}
                />
              ) : (
                <div
                  className="t"
                  title="double-click to rename"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenaming({ id: c.id, text: c.title });
                  }}
                >
                  {c.title || "(untitled)"}
                </div>
              )}
              <div className="m">
                <span className="mono">{c.modelId}</span>
                <span className="spacer" />
                {ago(c.updatedAt)}
                <button
                  className="ghost tiny x edit"
                  title="rename chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming({ id: c.id, text: c.title });
                  }}
                >
                  ✎
                </button>
                <button
                  className="ghost tiny x"
                  title="delete chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(c.id);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="col">
        <div className="pg-config">
          <div className="row">
            <ModelPicker
              value={config.modelId}
              groupModels={groupModels}
              onChange={(modelId) => modelId !== config.modelId && changeConfig({ modelId })}
            />
            <ProviderPicker modelId={config.modelId} />
            <button
              className={`toggle ${treeOpen ? "on" : ""}`}
              onClick={() => setTreeOpen(!treeOpen)}
              title="the conversation's branches"
            >
              tree
            </button>
            <button className={`toggle ${promptOpen ? "on" : ""}`} onClick={() => setPromptOpen(!promptOpen)}>
              system prompt{config.systemPrompt.trim() ? ` · ${config.systemPrompt.length.toLocaleString()} chars` : " · none"}
            </button>
            <button
              className={`toggle ${collapseThinking ? "on" : ""}`}
              onClick={toggleThinking}
              title="fold thinking away in this chat; click a folded block to open it"
            >
              fold thinking
            </button>
            <button
              className="toggle"
              onClick={copyMarkdown}
              disabled={streaming || path.length === 0}
              title="the branch on screen, with thinking and your comments — pastes formatted into Google Docs"
            >
              {copied ? "copied ✓" : "copy as markdown"}
            </button>
          </div>
          {promptOpen ? (
            <textarea
              className="pg-system"
              value={config.systemPrompt}
              placeholder="You are a helpful assistant…  (leave empty to send no system message)"
              onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
              onBlur={(e) => changeConfig({ systemPrompt: e.target.value })}
            />
          ) : config.systemPrompt.trim() ? (
            <div className="pg-system-peek" onClick={() => setPromptOpen(true)}>
              {config.systemPrompt}
            </div>
          ) : null}
        </div>

        <div className="scrollwrap">
          <div className="scroll" ref={scroller} onScroll={onScroll}>
            <div className="pg-doc" ref={doc}>
            <div className="thread">
              {path.length === 0 ? (
                <div className="hint" style={{ fontFamily: "var(--serif)", fontSize: 18 }}>
                  {config.modelId ? (
                    <>
                      Talking to <b>{config.modelId}</b>. Nothing is hidden here. Say something.
                    </>
                  ) : (
                    "Pick any OpenRouter model above, set a system prompt if you like, and start talking."
                  )}
                </div>
              ) : null}

              {path.map((m) => {
                const marker: string[] = [];
                if (m.role === "assistant" && m.meta?.requestedModel !== undefined) {
                  if (prevModel !== undefined && m.meta.requestedModel !== prevModel)
                    marker.push(`model → ${m.meta.requestedModel}`);
                  if (prevPrompt !== undefined && (m.meta.systemPrompt ?? "") !== prevPrompt)
                    marker.push("system prompt changed");
                  prevModel = m.meta.requestedModel;
                  prevPrompt = m.meta.systemPrompt ?? "";
                }
                const sibs = siblingsOf(tree, m);
                const at = sibs.findIndex((x) => x.id === m.id);
                const saved = !m.id.startsWith("tmp-");
                return (
                  <Fragment key={m.id}>
                    {marker.length ? <div className="pg-marker">{marker.join(" · ")}</div> : null}
                    {editing?.id === m.id ? (
                      <div className="msg user pg-edit">
                        <div className="who">you · editing — sends as a new branch, the original stays</div>
                        <textarea
                          autoFocus
                          value={editing.text}
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault();
                              submitEdit(m);
                            } else if (e.key === "Escape") setEditing(null);
                          }}
                        />
                        <div className="acts">
                          <button className="tiny" onClick={() => setEditing(null)}>
                            cancel
                          </button>
                          <button className="tiny primary" disabled={!editing.text.trim()} onClick={() => submitEdit(m)}>
                            send as new branch
                          </button>
                        </div>
                      </div>
                    ) : (
                      <Message msg={m} revealed details={details} thinking={collapseThinking ? "collapsed" : "inline"} />
                    )}
                    {editing?.id !== m.id && (sibs.length > 1 || saved) ? (
                      <div className="pg-actions">
                        {sibs.length > 1 ? (
                          <span className="pg-sibs" title="other versions of this turn">
                            <button className="ghost tiny" disabled={streaming || at <= 0} onClick={() => pick(sibs[at - 1].id)}>
                              ‹
                            </button>
                            {at + 1}/{sibs.length}
                            <button
                              className="ghost tiny"
                              disabled={streaming || at >= sibs.length - 1}
                              onClick={() => pick(sibs[at + 1].id)}
                            >
                              ›
                            </button>
                          </span>
                        ) : null}
                        {saved && !streaming ? (
                          m.role === "user" ? (
                            <button className="ghost tiny hov" onClick={() => setEditing({ id: m.id, text: m.content })}>
                              edit
                            </button>
                          ) : (
                            <button className="ghost tiny hov" onClick={() => send(undefined, { regenerate: m.id })}>
                              regenerate
                            </button>
                          )
                        ) : null}
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}

              {error ? <div className="errbar">{error}</div> : null}
            </div>
            <CommentMargin
              docRef={doc}
              chatId={chatId}
              comments={comments}
              onChange={setComments}
              relayoutKey={`${head}:${msgs.length}:${details}:${editing?.id}:${collapseThinking}`}
              isKnown={(id) => tree.byId.has(id)}
              onError={setError}
            />
            </div>
          </div>
          {!atBottom && path.length ? (
            <button className="jump-latest" onClick={jumpToLatest}>
              {streaming ? "still writing" : "latest"} &darr;
            </button>
          ) : null}
        </div>

        <div className="composer">
          <div className="row">
            <textarea
              ref={ta}
              value={draft}
              placeholder="Say something…  (⌘/Ctrl+Enter to send)"
              onChange={(e) => {
                setDraft(e.target.value);
                saveComposer(chatId, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitDraft();
                }
              }}
            />
            {streaming ? (
              <button onClick={() => abort.current?.abort()}>Stop</button>
            ) : (
              <button className="primary" disabled={!draft.trim() || !config.modelId} onClick={submitDraft}>
                Send
              </button>
            )}
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
                value={config.settings.temperature}
                onChange={(e) => changeConfig({ settings: { ...config.settings, temperature: Number(e.target.value) } })}
              />
            </label>
            <label>
              max tokens
              <input
                className="num"
                type="number"
                step="100"
                min="16"
                value={config.settings.maxTokens}
                onChange={(e) => changeConfig({ settings: { ...config.settings, maxTokens: Number(e.target.value) } })}
              />
            </label>
            <label>
              reasoning
              <select
                value={config.settings.reasoning}
                onChange={(e) =>
                  changeConfig({ settings: { ...config.settings, reasoning: e.target.value as RoundSettings["reasoning"] } })
                }
              >
                <option value="auto">auto</option>
                <option value="off">off</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
            {canRetry ? (
              <button className="tiny" onClick={() => send(undefined, { retry: true })}>
                {last?.role === "user" ? "retry last turn" : "regenerate"}
              </button>
            ) : null}
            <span className="spacer" style={{ flex: 1 }} />
            {chatId ? <span className="mono">data/chats/{chatId}.json</span> : null}
            <button className="tiny" onClick={openRaw} disabled={!chatId}>
              raw log
            </button>
          </div>
        </div>
      </div>

      {treeOpen ? (
        <BranchTree
          tree={tree}
          path={path}
          headId={head}
          noteCounts={noteCounts}
          disabled={streaming}
          onPick={pick}
          onClose={() => setTreeOpen(false)}
        />
      ) : null}

      {details ? (
        <Inspector
          events={shown}
          onClear={() => setEvents([])}
          onOpenRaw={openRaw}
          rawAvailable={Boolean(chatId)}
          verbose={verbose}
          setVerbose={setVerbose}
        />
      ) : null}

      {raw !== null ? (
        <div className="modal-bg" onClick={() => setRaw(null)}>
          <div className="modal" style={{ width: 900 }} onClick={(e) => e.stopPropagation()}>
            <h2>Raw chat log</h2>
            <div className="hint mono">data/chats/logs/{chatId}.jsonl</div>
            <pre className="mono pg-raw">{raw || "(empty)"}</pre>
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
}

/** Type-ahead over the OpenRouter catalogue; with an empty query it offers the models in your groups. */
function ModelPicker({
  value,
  groupModels,
  onChange,
}: {
  value: string;
  groupModels: string[];
  onChange: (id: string) => void;
}) {
  const [q, setQ] = useState(value);
  const [hits, setHits] = useState<{ id: string; name: string }[]>([]);
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const timer = useRef<number>();
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => setQ(value), [value]);

  // Pretty name for the committed model.
  useEffect(() => {
    if (!value) return setName("");
    let dead = false;
    searchCatalog(value)
      .then(({ models }) => !dead && setName(models.find((m) => m.id === value)?.name || ""))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [value]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    const query = q.trim();
    if (!query || query === value) {
      setHits(groupModels.map((id) => ({ id, name: "in your groups" })));
      setCursor(0);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const { models } = await searchCatalog(query);
        setHits(models);
        setCursor(0);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q, value, groupModels.join(" ")]);

  const visible = hits.slice(0, 12);

  function commit(id: string) {
    const v = id.trim();
    setOpen(false);
    if (v) onChange(v);
    else setQ(value);
  }

  return (
    <div className="addrow pg-model">
      <input
        value={q}
        placeholder="model — any openrouter id, e.g. anthropic/claude-sonnet-4.5"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onBlur={() =>
          window.setTimeout(() => {
            setOpen(false);
            setQ(latest.current);
          }, 150)
        }
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, visible.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(open && visible[cursor] ? visible[cursor].id : q);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setOpen(false);
            setQ(value);
          }
        }}
      />
      {name ? <span className="pg-model-name">{name}</span> : null}
      {open && visible.length ? (
        <div className="suggest">
          {visible.map((m, i) => (
            <div key={m.id} className={i === cursor ? "on" : ""} onMouseDown={() => commit(m.id)}>
              {m.id}
              <span className="nm">{m.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
