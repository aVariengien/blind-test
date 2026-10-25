import type { ChatComment, CompareRun, Group, ModelProviders, PlaygroundChat, PlaygroundConfig, Room, Round, Validation } from "./types";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers || {}) } : init?.headers,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error ? JSON.stringify(data.error) : `${res.status} ${text.slice(0, 200)}`);
  return data as T;
}

export const getStatus = () =>
  jfetch<{ hasKey: boolean; keySource: string; hasOpenAiKey: boolean }>("/api/status");

export const getGroups = () => jfetch<{ groups: Group[] }>("/api/groups").then((d) => d.groups);

export const saveGroup = (g: { id?: string; name: string; modelIds: string[] }) =>
  jfetch<{ groups: Group[]; results: Validation[] }>("/api/groups", { method: "POST", body: JSON.stringify(g) });

export const deleteGroup = (id: string) =>
  jfetch<{ groups: Group[] }>(`/api/groups/${id}`, { method: "DELETE" }).then((d) => d.groups);

export const calibrateGroup = (id: string) =>
  jfetch<{ groups: Group[] }>(`/api/groups/${id}/calibrate`, { method: "POST" }).then((d) => d.groups);

export const validateIds = (ids: string[]) =>
  jfetch<{ results: Validation[] }>("/api/catalog/validate", { method: "POST", body: JSON.stringify({ ids }) }).then(
    (d) => d.results,
  );

export const searchCatalog = (q: string) =>
  jfetch<{ models: { id: string; name: string; context_length?: number }[]; total: number; fetchedAt: number }>(
    `/api/catalog/search?q=${encodeURIComponent(q)}`,
  );

export const getProviders = (modelId: string, refresh = false) =>
  jfetch<ModelProviders>(`/api/providers?model=${encodeURIComponent(modelId)}${refresh ? "&refresh=1" : ""}`);

/** Pin a model to a provider tag everywhere in the app; `null` goes back to the default pick. */
export const pinProvider = (modelId: string, tag: string | null) =>
  jfetch<ModelProviders>("/api/providers", { method: "POST", body: JSON.stringify({ modelId, tag }) });

export const listRounds = () => jfetch<{ rounds: Round[] }>("/api/rounds").then((d) => d.rounds);

export const getRound = (id: string) => jfetch<{ round: Round }>(`/api/rounds/${id}`).then((d) => d.round);

export const newRound = (groupId: string) =>
  jfetch<{ round: Round }>("/api/rounds", { method: "POST", body: JSON.stringify({ groupId }) }).then((d) => d.round);

export const deleteRound = (id: string) => jfetch<{ ok: boolean }>(`/api/rounds/${id}`, { method: "DELETE" });

export const submitGuess = (id: string, guess: string) =>
  jfetch<{ round: Round }>(`/api/rounds/${id}/guess`, { method: "POST", body: JSON.stringify({ guess }) }).then(
    (d) => d.round,
  );

export const updateSettings = (id: string, settings: Partial<Round["settings"]>) =>
  jfetch<{ round: Round }>(`/api/rounds/${id}/settings`, { method: "POST", body: JSON.stringify(settings) }).then(
    (d) => d.round,
  );

export const getRawLog = async (id: string): Promise<string> => {
  const res = await fetch(`/api/rounds/${id}/log`);
  if (!res.ok) throw new Error(`log ${res.status}`);
  return res.text();
};

/** POST a chat turn and consume the server-sent event stream. */
export function streamMessage(
  roundId: string,
  body: { content?: string; retry?: boolean },
  onEvent: (evt: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamSse(`/api/rounds/${roundId}/message`, body, onEvent, signal);
}

async function streamSse(url: string, body: unknown, onEvent: (evt: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(msg || `stream ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

export const listCompareRuns = () => jfetch<{ runs: CompareRun[] }>("/api/compare").then((d) => d.runs);

export const getCompareRun = (id: string) => jfetch<{ run: CompareRun }>(`/api/compare/${id}`).then((d) => d.run);

export const startCompare = (groupId: string, prompts: string[]) =>
  jfetch<{ run: CompareRun }>("/api/compare", { method: "POST", body: JSON.stringify({ groupId, prompts }) }).then(
    (d) => d.run,
  );

export const deleteCompareRun = (id: string) => jfetch<{ ok: boolean }>(`/api/compare/${id}`, { method: "DELETE" });

export const guessCompare = (id: string, guesses: Record<string, string>) =>
  jfetch<{ run: CompareRun }>(`/api/compare/${id}/guess`, { method: "POST", body: JSON.stringify({ guesses }) }).then(
    (d) => d.run,
  );

export const listRooms = () => jfetch<{ rooms: Room[] }>("/api/rooms").then((d) => d.rooms);

export const getRoom = (id: string) => jfetch<{ room: Room }>(`/api/rooms/${id}`).then((d) => d.room);

export const newRoom = (groupId: string, maxCascade?: number) =>
  jfetch<{ room: Room }>("/api/rooms", { method: "POST", body: JSON.stringify({ groupId, maxCascade }) }).then(
    (d) => d.room,
  );

export const deleteRoom = (id: string) => jfetch<{ ok: boolean }>(`/api/rooms/${id}`, { method: "DELETE" });

export const sendRoomMessage = (id: string, content: string) =>
  jfetch<{ room: Room }>(`/api/rooms/${id}/message`, { method: "POST", body: JSON.stringify({ content }) }).then(
    (d) => d.room,
  );

export const guessRoom = (id: string, guesses: Record<string, string>) =>
  jfetch<{ room: Room }>(`/api/rooms/${id}/guess`, { method: "POST", body: JSON.stringify({ guesses }) }).then(
    (d) => d.room,
  );

export const listChats = () => jfetch<{ chats: PlaygroundChat[] }>("/api/chats").then((d) => d.chats);

export const getChat = (id: string) => jfetch<{ chat: PlaygroundChat }>(`/api/chats/${id}`).then((d) => d.chat);

export const newChat = (config: PlaygroundConfig) =>
  jfetch<{ chat: PlaygroundChat }>("/api/chats", { method: "POST", body: JSON.stringify(config) }).then((d) => d.chat);

export const updateChatConfig = (id: string, config: PlaygroundConfig) =>
  jfetch<{ chat: PlaygroundChat }>(`/api/chats/${id}/config`, { method: "POST", body: JSON.stringify(config) }).then(
    (d) => d.chat,
  );

export const deleteChat = (id: string) => jfetch<{ ok: boolean }>(`/api/chats/${id}`, { method: "DELETE" });

export const setChatHead = (id: string, headId: string) =>
  jfetch<{ headId: string }>(`/api/chats/${id}/head`, { method: "POST", body: JSON.stringify({ headId }) });

export const getChatLog = async (id: string): Promise<string> => {
  const res = await fetch(`/api/chats/${id}/log`);
  if (!res.ok) throw new Error(`log ${res.status}`);
  return res.text();
};

/** Send a playground turn (applying any config change first) and consume the stream. */
export const streamChat = (
  id: string,
  body: PlaygroundConfig & { content?: string; parentId?: string | null; regenerate?: string; retry?: boolean },
  onEvent: (evt: any) => void,
  signal?: AbortSignal,
) => streamSse(`/api/chats/${id}/message`, body, onEvent, signal);

export const addComment = (
  chatId: string,
  c: Pick<ChatComment, "messageId" | "field" | "quote" | "prefix" | "suffix" | "body">,
) =>
  jfetch<{ comments: ChatComment[] }>(`/api/chats/${chatId}/comments`, { method: "POST", body: JSON.stringify(c) }).then(
    (d) => d.comments,
  );

export const editComment = (chatId: string, id: string, body: string) =>
  jfetch<{ comments: ChatComment[] }>(`/api/chats/${chatId}/comments/${id}`, {
    method: "POST",
    body: JSON.stringify({ body }),
  }).then((d) => d.comments);

export const deleteComment = (chatId: string, id: string) =>
  jfetch<{ comments: ChatComment[] }>(`/api/chats/${chatId}/comments/${id}`, { method: "DELETE" }).then(
    (d) => d.comments,
  );
