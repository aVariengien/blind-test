export type ChatRole = "user" | "assistant";

export interface MsgMeta {
  requestedAt?: number;
  firstTokenMs?: number;
  totalMs?: number;
  finishReason?: string | null;
  nativeFinishReason?: string | null;
  usage?: Record<string, any> | null;
  reasoningTokens?: number | null;
  chunkCount?: number;
  /* only present once the round is revealed */
  modelId?: string;
  provider?: string;
  generationId?: string;
  cost?: number | null;
  generation?: Record<string, any> | null;
  error?: string;
  /* playground only: what this turn was actually sent with */
  requestedModel?: string;
  systemPrompt?: string;
}

export interface ChatMessage {
  id: string;
  /** playground only: the message this one follows (messages form a tree of branches) */
  parentId?: string | null;
  role: ChatRole;
  content: string;
  reasoning?: string;
  reasoningDetails?: unknown[];
  toolCalls?: ToolCall[];
  annotations?: unknown[];
  createdAt: number;
  meta?: MsgMeta;
  /** client-only: still streaming */
  pending?: boolean;
}

export interface ToolCall {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface RoundSettings {
  temperature: number;
  maxTokens: number;
  reasoning: "auto" | "off" | "low" | "medium" | "high";
}

export interface Round {
  id: string;
  seq: number;
  groupId: string;
  groupName: string;
  modelIds: string[];
  settings: RoundSettings;
  guess: string | null;
  correct: boolean | null;
  guessedAt: number | null;
  revealed: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  userMessageCount: number;
  actualModel: string | null;
  actualModelName: string | null;
  messages?: ChatMessage[];
}

export interface ModelSpeedSample {
  modelId: string;
  ok: boolean;
  ttftMs: number;
  msPerChar: number;
  tokensPerSecond: number | null;
  chars: number;
  error?: string;
  testedAt: number;
}

export interface GroupSpeedProfile {
  targetTtftMs: number;
  targetMsPerChar: number;
  targetTokensPerSecond: number | null;
  samples: ModelSpeedSample[];
  computedAt: number;
}

export interface Group {
  id: string;
  name: string;
  modelIds: string[];
  createdAt: number;
  updatedAt: number;
  speedProfile?: GroupSpeedProfile | null;
  speedStatus?: "idle" | "pending" | "ready" | "error";
  speedError?: string;
}

export interface Validation {
  id: string;
  valid: boolean;
  name?: string;
  note?: string;
  suggestions?: string[];
}

/** One line in the live event log sidebar. */
export interface LogEvent {
  t: number;
  kind: string;
  detail: string;
  tone?: "muted" | "warn" | "think" | "tool";
}

// Shared by compare and rooms: real identity is hidden behind a shuffled
// @model1, @model2, … handle until a guess reveals it — modelId/modelName
// are only present once revealed.
export interface BlindParticipant {
  modelId?: string;
  modelName?: string;
  handle: string;
}

export interface BlindGuess {
  handle: string;
  guessedModelId: string;
  correct: boolean;
}

export interface CompareResponse {
  handle: string;
  /** only present once the run is revealed */
  modelId?: string;
  modelName?: string;
  content: string;
  error?: string;
  totalMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  avgDistance?: number | null;
}

export interface ComparePromptResult {
  prompt: string;
  responses: CompareResponse[];
  embeddingError?: string;
}

export interface RoomMessage {
  id: string;
  role: "user" | "model";
  handle: string;
  /** only present once the room is revealed */
  modelId?: string;
  content: string;
  error?: string;
  createdAt: number;
  meta?: { totalMs?: number; usage?: { prompt_tokens?: number; completion_tokens?: number } | null };
}

export interface Room {
  id: string;
  groupId: string;
  groupName: string;
  participants: BlindParticipant[];
  rulesPrompt: string;
  processing: boolean;
  error?: string;
  revealed: boolean;
  guesses: BlindGuess[] | null;
  maxCascade: number;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  messages?: RoomMessage[];
}

export interface CompareRun {
  id: string;
  groupId: string;
  groupName: string;
  participants: BlindParticipant[];
  promptCount: number;
  status: "running" | "done" | "error";
  error?: string;
  revealed: boolean;
  guesses: BlindGuess[] | null;
  createdAt: number;
  updatedAt: number;
  prompts?: string[];
  results?: ComparePromptResult[];
}

/** A plain, un-blinded chat from the playground tab. */
export interface PlaygroundChat {
  id: string;
  title: string;
  modelId: string;
  systemPrompt: string;
  settings: RoundSettings;
  messageCount: number;
  /** last message of the branch being viewed */
  headId?: string | null;
  comments: ChatComment[];
  /** Show thinking folded away instead of inline above the answer. Absent = inline. */
  collapseThinking?: boolean;
  createdAt: number;
  updatedAt: number;
  messages?: ChatMessage[];
}

/** A note on a stretch of one message's text, anchored by the quoted text plus context. */
export interface ChatComment {
  id: string;
  messageId: string;
  field: "content" | "reasoning";
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlaygroundConfig {
  modelId?: string;
  systemPrompt?: string;
  settings?: Partial<RoundSettings>;
  title?: string;
  collapseThinking?: boolean;
}

/** One OpenRouter host serving a model. */
export interface ProviderEndpoint {
  tag: string;
  name: string;
  quantization: string | null;
  status: number;
  uptime1d: number | null;
  uptime30m: number | null;
  contextLength: number | null;
  pricing?: Record<string, string>;
}

/** The provider a model is pinned to, app-wide. `auto` = the default pick, not chosen by hand. */
export interface ProviderPin {
  tag: string;
  name: string;
  auto: boolean;
  pinnedAt: number;
}

export interface ModelProviders {
  modelId: string;
  pin: ProviderPin | null;
  recommended: string | null;
  /** false when the pinned provider no longer serves the model (requests will fail) */
  pinAvailable: boolean | null;
  endpoints: ProviderEndpoint[];
  error?: string;
}
