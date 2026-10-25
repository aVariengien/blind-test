import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const ROUNDS_DIR = path.join(DATA_DIR, "rounds");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const COMPARE_DIR = path.join(DATA_DIR, "compare");
const ROOM_DIR = path.join(DATA_DIR, "rooms");
const CHATS_DIR = path.join(DATA_DIR, "chats");
const CHAT_LOGS_DIR = path.join(CHATS_DIR, "logs");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const CATALOG_FILE = path.join(DATA_DIR, "catalog.json");
const PROVIDERS_FILE = path.join(DATA_DIR, "providers.json");

const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENAI = "https://api.openai.com/v1";
const EMBEDDING_MODEL = "text-embedding-3-small";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h

// Routing suffixes OpenRouter accepts that never appear as catalog entries.
const VARIANT_SUFFIXES = new Set(["nitro", "floor", "online", "extended", "thinking", "exacto"]);

/* ------------------------------------------------------------------ utils */

function json(res: ServerResponse, code: number, payload: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function ensureDirs() {
  await fs.mkdir(ROUNDS_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
  await fs.mkdir(COMPARE_DIR, { recursive: true });
  await fs.mkdir(ROOM_DIR, { recursive: true });
  await fs.mkdir(CHAT_LOGS_DIR, { recursive: true });
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// Serializes read-modify-write cycles against one file so concurrent writers
// (e.g. several groups calibrating their speed in the background at once)
// can't race on the shared `${file}.tmp` path or silently clobber each
// other's update. Keyed by path so unrelated files never wait on each other.
const fileLocks = new Map<string, Promise<unknown>>();
function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prior = fileLocks.get(file) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  fileLocks.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function safeId(id: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

/* ------------------------------------------------------------- redaction */

// Everything the app sends back about *metadata* (errors, provider info) is run
// through this while a round is unrevealed, so a stray error string like
// "anthropic/claude-x is temporarily rate limited" can never give the game away.
// Message content and reasoning are deliberately NOT redacted — that is the game.
function makeRedactor(modelId: string, modelName?: string, extraTerms: string[] = []) {
  const terms = new Set<string>();
  const add = (t?: string) => {
    if (t && t.length > 2) terms.add(t.toLowerCase());
  };
  add(modelId);
  const [vendor, rest] = modelId.split("/");
  add(vendor);
  add(rest);
  rest?.split(/[-:._]/).forEach(add);
  vendor?.split(/[-:._]/).forEach(add);
  if (modelName) {
    add(modelName);
    modelName.split(/[\s\-()/,]+/).forEach(add);
  }
  extraTerms.forEach(add);
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const t of sorted) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      out = out.replace(re, "███");
    }
    return out;
  };
}

// Upstream error bodies are a leak surface all of their own: they name the
// serving provider, quote the model id, and echo your account id. Only a
// scrubbed summary reaches the browser; the full body always lands in the log.
function safeUpstreamError(text: string, status: number, redact: (s: string) => string): string {
  try {
    const parsed = JSON.parse(text);
    const err = parsed?.error ?? parsed;
    const message = typeof err?.message === "string" ? redact(err.message) : "";
    const retry = err?.metadata?.retry_after_seconds;
    const parts = [message || `upstream error ${status}`];
    if (typeof retry === "number") parts.push(`retry in ${retry}s`);
    return parts.join(" — ").slice(0, 400);
  } catch {
    return `upstream error ${status} — see the round log for the full response`;
  }
}

/* ----------------------------------------------------------- self-id gate */

// A model naming its own maker or family is the biggest tell there is —
// "created by OpenAI" gives the round away as surely as the real model id
// would. Unlike makeRedactor above (which only scrubs the *actual* drawn
// model's own name out of error text), this scrubs any well-known AI vendor
// or model family name out of the visible answer/reasoning itself, live,
// because a wrong guess at "which AI company" is just as informative as a
// right one. It's a permanent filter, not a pre-reveal secrecy step — these
// strings would spoil nothing useful even after the reveal, so what gets
// stored (and replayed on reload) is the masked text, not the original.
// One glyph, always — a fixed multi-char mask (e.g. "███") would visually
// hint at how long the masked term was ("Claude" vs "Google DeepMind").
const SELF_ID_MASK = "█";
const SELF_ID_TERMS = [
  "OpenAI",
  "ChatGPT",
  "GPT-5",
  "GPT-4o",
  "GPT-4",
  "GPT-3",
  "GPT",
  "Anthropic",
  "Claude",
  "Google",
  "Google DeepMind",
  "DeepMind",
  "Gemini",
  "Bard",
  "Meta AI",
  "LLaMA",
  "Llama",
  "Mistral AI",
  "Mistral",
  "DeepSeek",
  "xAI",
  "Grok",
  "Microsoft Copilot",
  "Copilot",
  "Cohere",
  "Alibaba Qwen",
  "Qwen",
  "Perplexity AI",
  "Perplexity",
  "AI21 Labs",
  "AI21",
  "Jamba",
  "Inflection AI",
  "Inflection",
  "NVIDIA Nemotron",
  "Nemotron",
  "MiniMax",
  "01.AI",
  "Reka AI",
  "Reka",
  "Zhipu",
  "GLM",
  "Baidu",
  "Ernie",
];
// Longest first, so "Google DeepMind" consumes as one match instead of the
// alternation stopping at the shorter "DeepMind" inside it.
const SELF_ID_SORTED = [...SELF_ID_TERMS].sort((a, b) => b.length - a.length);
const SELF_ID_REGEX = new RegExp(
  `\\b(?:${SELF_ID_SORTED.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})(?:-?\\d[\\w.]*)?\\b`,
  "gi",
);
const SELF_ID_LOWER = SELF_ID_SORTED.map((t) => t.toLowerCase());
const SELF_ID_MAX_LEN = Math.max(...SELF_ID_TERMS.map((t) => t.length));

// How many trailing characters of `buf` could still grow into one of our
// terms if more text arrives — i.e. the longest suffix of buf that equals a
// (case-insensitive) prefix of some term. That many characters must be held
// back rather than released, so a term split across two stream chunks (e.g.
// "Open" then "AI") is never let out half-masked.
function selfIdHoldback(buf: string): number {
  const lower = buf.toLowerCase();
  const cap = Math.min(buf.length, SELF_ID_MAX_LEN - 1);
  for (let len = cap; len > 0; len--) {
    const suffix = lower.slice(lower.length - len);
    if (SELF_ID_LOWER.some((t) => t.startsWith(suffix))) return len;
  }
  return 0;
}

/** Streaming-safe scrubber: feed it chunks as they arrive via push(), call
 * flush() once at the end to release whatever's left. Never emits a term
 * half-masked, even when it's split across two pushes. */
function createSelfIdGate() {
  let carry = "";
  return {
    push(chunk: string): string {
      carry = (carry + chunk).replace(SELF_ID_REGEX, SELF_ID_MASK);
      const hold = selfIdHoldback(carry);
      const commitLen = carry.length - hold;
      if (commitLen <= 0) return "";
      const out = carry.slice(0, commitLen);
      carry = carry.slice(commitLen);
      return out;
    },
    flush(): string {
      const out = carry.replace(SELF_ID_REGEX, SELF_ID_MASK);
      carry = "";
      return out;
    },
  };
}

// Non-streaming version for text that's already complete (serving a stored
// round back to the browser — see publicMessage). What's actually stored on
// disk is the model's real, untouched text; this only ever runs at the
// boundary where a message is handed to the client, live or on replay.
function maskSelfId(text: string): string {
  return text.replace(SELF_ID_REGEX, SELF_ID_MASK);
}

/* --------------------------------------------------------------- catalog */

type CatalogEntry = {
  id: string;
  name: string;
  context_length?: number;
  pricing?: Record<string, string>;
  description?: string;
};
type Catalog = { fetchedAt: number; models: CatalogEntry[] };

let catalogMemo: Catalog | null = null;
let catalogInflight: Promise<Catalog> | null = null;

async function fetchCatalog(force = false): Promise<Catalog> {
  const now = Date.now();
  if (!catalogMemo) catalogMemo = await readJsonFile<Catalog | null>(CATALOG_FILE, null);
  if (!force && catalogMemo && now - catalogMemo.fetchedAt < CATALOG_TTL_MS) return catalogMemo;
  if (catalogInflight) return catalogInflight;

  catalogInflight = (async () => {
    try {
      const r = await fetch(`${OPENROUTER}/models`);
      if (!r.ok) throw new Error(`OpenRouter /models ${r.status}`);
      const data = (await r.json()) as { data: CatalogEntry[] };
      const models = (data.data || []).map((m) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing,
        description: typeof m.description === "string" ? m.description.slice(0, 400) : undefined,
      }));
      const cat: Catalog = { fetchedAt: Date.now(), models };
      catalogMemo = cat;
      await ensureDirs();
      await writeJsonFile(CATALOG_FILE, cat);
      return cat;
    } catch (err) {
      // Offline / rate limited: keep serving the stale cache if we have one.
      if (catalogMemo) return catalogMemo;
      throw err;
    } finally {
      catalogInflight = null;
    }
  })();
  return catalogInflight;
}

function catalogIndex(cat: Catalog) {
  const byId = new Map<string, CatalogEntry>();
  for (const m of cat.models) byId.set(m.id.toLowerCase(), m);
  return byId;
}

function suggestIds(cat: Catalog, query: string, limit = 5): string[] {
  const q = query.toLowerCase();
  const tokens = q.split(/[/\-:._\s]+/).filter((t) => t.length > 1);
  const scored: Array<{ id: string; score: number }> = [];
  for (const m of cat.models) {
    const id = m.id.toLowerCase();
    let score = 0;
    if (id.includes(q)) score += 100;
    for (const t of tokens) if (id.includes(t)) score += t.length;
    if (score > 0) scored.push({ id: m.id, score: score - Math.abs(id.length - q.length) * 0.1 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.id);
}

type Validation = { id: string; valid: boolean; name?: string; note?: string; suggestions?: string[] };

async function validateIds(ids: string[]): Promise<Validation[]> {
  const cat = await fetchCatalog();
  const byId = catalogIndex(cat);
  return ids.map((raw) => {
    const id = raw.trim();
    if (!id) return { id, valid: false, suggestions: [] };
    const hit = byId.get(id.toLowerCase());
    if (hit) return { id: hit.id, valid: true, name: hit.name };
    const colon = id.lastIndexOf(":");
    if (colon > 0) {
      const base = id.slice(0, colon);
      const suffix = id.slice(colon + 1).toLowerCase();
      const baseHit = byId.get(base.toLowerCase());
      if (baseHit && VARIANT_SUFFIXES.has(suffix)) {
        return { id, valid: true, name: `${baseHit.name} (:${suffix})`, note: `routing variant of ${base}` };
      }
    }
    return { id, valid: false, suggestions: suggestIds(cat, id) };
  });
}

/* ------------------------------------------------------------- providers */

// Every model is pinned to exactly one OpenRouter provider, app-wide, and
// sent with allow_fallbacks: false — so a model is always served the same
// way (same quantization, same speed, same quirks) across rounds, compare,
// rooms, the speed test and the playground, instead of whichever host
// OpenRouter's load balancer picks that minute. If the pinned provider is
// down the request fails rather than silently switching.
//
// Until you pick one by hand, a model gets a default (see pickDefaultEndpoint):
// the model maker's own API when OpenRouter carries it, otherwise the most
// reliable, least-quantized host.

type ProviderEndpoint = {
  tag: string;
  name: string;
  quantization: string | null;
  status: number;
  uptime1d: number | null;
  uptime30m: number | null;
  contextLength: number | null;
  pricing?: Record<string, string>;
};

type ProviderPin = { tag: string; name: string; auto: boolean; pinnedAt: number };

const ENDPOINTS_TTL_MS = 15 * 60 * 1000;
const endpointsMemo = new Map<string, { fetchedAt: number; endpoints: ProviderEndpoint[] }>();

async function fetchEndpoints(modelId: string, force = false): Promise<ProviderEndpoint[]> {
  const hit = endpointsMemo.get(modelId);
  if (!force && hit && Date.now() - hit.fetchedAt < ENDPOINTS_TTL_MS) return hit.endpoints;
  try {
    // Ids are "author/slug[:variant]" — the slash has to stay a real path separator.
    const r = await fetch(`${OPENROUTER}/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`);
    if (!r.ok) throw new Error(`OpenRouter endpoints ${r.status}`);
    const data = (await r.json()) as any;
    const endpoints: ProviderEndpoint[] = (data?.data?.endpoints || [])
      .filter((e: any) => typeof e?.tag === "string" && e.tag)
      .map((e: any) => ({
        tag: e.tag,
        name: String(e.provider_name || e.tag),
        quantization: typeof e.quantization === "string" ? e.quantization : null,
        status: typeof e.status === "number" ? e.status : 0,
        uptime1d: typeof e.uptime_last_1d === "number" ? e.uptime_last_1d : null,
        uptime30m: typeof e.uptime_last_30m === "number" ? e.uptime_last_30m : null,
        contextLength: typeof e.context_length === "number" ? e.context_length : null,
        pricing: e.pricing,
      }));
    // The same tag can be listed twice (e.g. two deployments in one region).
    const unique = [...new Map(endpoints.map((e) => [e.tag, e])).values()];
    endpointsMemo.set(modelId, { fetchedAt: Date.now(), endpoints: unique });
    return unique;
  } catch (err) {
    // Offline / rate limited: a stale list beats none.
    if (hit) return hit.endpoints;
    throw err;
  }
}

// Model authors whose own API shows up on OpenRouter under a different name.
const FIRST_PARTY_ALIASES: Record<string, string[]> = {
  qwen: ["alibaba"],
  "meta-llama": ["meta"],
  moonshotai: ["moonshot"],
  mistralai: ["mistral"],
  "x-ai": ["xai"],
  "z-ai": ["zai"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function isFirstParty(modelId: string, e: ProviderEndpoint): boolean {
  const author = modelId.split("/")[0].toLowerCase();
  const names = [author, ...(FIRST_PARTY_ALIASES[author] || [])].map(norm).filter(Boolean);
  const host = [norm(e.tag.split("/")[0]), norm(e.name)];
  // "google" matches both google-vertex and google-ai-studio.
  return names.some((n) => host.some((h) => h === n || h.startsWith(n)));
}

// Higher is better. "unknown" is what closed models report — they're served as the maker built them.
function precisionRank(q: string | null): number {
  if (!q || q === "unknown" || /^(bf16|fp16|fp32)$/.test(q)) return 3;
  if (/8/.test(q)) return 2;
  if (/6/.test(q)) return 1.5;
  return 1;
}

// Tag segments that are a cheaper/slower tier, not a different host: never a default.
const DEFERRED_TIERS = new Set(["flex", "batch"]);

function pickDefaultEndpoint(modelId: string, endpoints: ProviderEndpoint[]): ProviderEndpoint | null {
  const key = (e: ProviderEndpoint) => [
    e.status >= 0 ? 1 : 0,
    isFirstParty(modelId, e) ? 1 : 0,
    e.tag.split("/").some((s) => DEFERRED_TIERS.has(s)) ? 0 : 1,
    (e.uptime1d ?? 0) >= 98 ? 1 : 0,
    precisionRank(e.quantization),
    -e.tag.split("/").length, // the plain endpoint over a regional/priority variant of it
    e.uptime1d ?? 0,
  ];
  const ranked = [...endpoints].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
  return ranked[0] ?? null;
}

async function readPins(): Promise<Record<string, ProviderPin>> {
  return readJsonFile<Record<string, ProviderPin>>(PROVIDERS_FILE, {});
}

function mutatePins<T>(fn: (pins: Record<string, ProviderPin>) => T): Promise<T> {
  return withFileLock(PROVIDERS_FILE, async () => {
    const pins = await readPins();
    const result = fn(pins);
    await writeJsonFile(PROVIDERS_FILE, pins);
    return result;
  });
}

// The pin a request should go out with. A hand-picked pin is kept even if
// that provider has dropped the model (the request then fails loudly, and the
// picker says why); a default pin quietly moves to the new best choice.
async function resolvePin(modelId: string): Promise<ProviderPin | null> {
  const pins = await readPins();
  const current = pins[modelId];
  if (current && !current.auto) return current;
  let endpoints: ProviderEndpoint[];
  try {
    endpoints = await fetchEndpoints(modelId);
  } catch {
    return current ?? null; // can't see the catalogue right now — keep whatever we had
  }
  if (current && endpoints.some((e) => e.tag === current.tag)) return current;
  const best = pickDefaultEndpoint(modelId, endpoints);
  if (!best) return null;
  const pin: ProviderPin = { tag: best.tag, name: best.name, auto: true, pinnedAt: Date.now() };
  await mutatePins((p) => {
    p[modelId] = pin;
  });
  return pin;
}

/** The `provider` field for an OpenRouter request, or undefined when nothing could be pinned. */
async function providerRouting(modelId: string): Promise<Record<string, unknown> | undefined> {
  const pin = await resolvePin(modelId);
  return pin ? { order: [pin.tag], allow_fallbacks: false } : undefined;
}

/* --------------------------------------------------------- speed profile */

// A round's timing (time to first token, tokens/sec) is a fingerprint all its
// own — a model can be told apart from its group-mates just by how fast it
// types. To close that, every group gets a one-time speed test across its
// line-up: the slowest model's pace (+25% buffer) becomes the pace *every*
// model in that group is throttled down to when actually played, so speed
// stops being a usable signal. Reasoning text is left alone (see streamMessage) —
// only the visible answer is paced.

type ModelSpeedSample = {
  modelId: string;
  ok: boolean;
  ttftMs: number;
  msPerChar: number;
  tokensPerSecond: number | null;
  chars: number;
  error?: string;
  testedAt: number;
};

type GroupSpeedProfile = {
  targetTtftMs: number;
  targetMsPerChar: number;
  targetTokensPerSecond: number | null;
  samples: ModelSpeedSample[];
  computedAt: number;
};

const CALIBRATION_PROMPT =
  "Write one short paragraph (60-80 words) describing an ordinary rainy afternoon. No preamble, just the paragraph.";
const CALIBRATION_TIMEOUT_MS = 20_000;
// Used when a model can't be measured (timeout, error, empty reply) so a model
// we failed to clock is never assumed to be *faster* than it might really be.
const CALIBRATION_FALLBACK_TTFT_MS = 8_000;
const CALIBRATION_FALLBACK_MS_PER_CHAR = 120; // roughly a very slow, ~2 tok/s pace
const CALIBRATION_BUFFER = 1.25;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function calibrateModel(modelId: string, apiKey: string): Promise<ModelSpeedSample> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALIBRATION_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5199",
        "X-Title": "blind-test (speed calibration)",
      },
      body: JSON.stringify({
        model: modelId,
        provider: await providerRouting(modelId),
        stream: true,
        temperature: 0.7,
        max_tokens: 100,
        usage: { include: true },
        messages: [{ role: "user", content: CALIBRATION_PROMPT }],
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return {
        modelId,
        ok: false,
        ttftMs: 0,
        msPerChar: 0,
        tokensPerSecond: null,
        chars: 0,
        error: `${upstream.status} ${text.slice(0, 200)}`,
        testedAt: started,
      };
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstAt: number | null = null;
    let lastAt = started;
    let chars = 0;
    let completionTokens: number | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta || {};
        const text: string | undefined = delta.content ?? delta.reasoning ?? delta.reasoning_content;
        if (typeof text === "string" && text.length) {
          const now = Date.now();
          if (firstAt === null) firstAt = now;
          lastAt = now;
          chars += text.length;
        }
        if (chunk.usage?.completion_tokens != null) completionTokens = chunk.usage.completion_tokens;
      }
    }

    if (firstAt === null || chars === 0) {
      return {
        modelId,
        ok: false,
        ttftMs: 0,
        msPerChar: 0,
        tokensPerSecond: null,
        chars: 0,
        error: "no text received",
        testedAt: started,
      };
    }
    const ttftMs = firstAt - started;
    const genMs = Math.max(1, lastAt - firstAt);
    const msPerChar = genMs / chars;
    const tokensPerSecond = completionTokens ? completionTokens / (genMs / 1000) : null;
    return { modelId, ok: true, ttftMs, msPerChar, tokensPerSecond, chars, testedAt: started };
  } catch (err) {
    return {
      modelId,
      ok: false,
      ttftMs: 0,
      msPerChar: 0,
      tokensPerSecond: null,
      chars: 0,
      error: String(err).slice(0, 200),
      testedAt: started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function calibrateGroupSpeed(modelIds: string[], apiKey: string): Promise<GroupSpeedProfile> {
  const samples = await Promise.all(modelIds.map((id) => calibrateModel(id, apiKey)));
  const effective = samples.map((s) =>
    s.ok ? s : { ...s, ttftMs: CALIBRATION_FALLBACK_TTFT_MS, msPerChar: CALIBRATION_FALLBACK_MS_PER_CHAR },
  );
  const maxTtft = Math.max(...effective.map((s) => s.ttftMs));
  const maxMsPerChar = Math.max(...effective.map((s) => s.msPerChar));
  const rates = samples.filter((s): s is ModelSpeedSample & { tokensPerSecond: number } => s.ok && s.tokensPerSecond != null);
  const minRate = rates.length ? Math.min(...rates.map((s) => s.tokensPerSecond)) : null;
  return {
    targetTtftMs: Math.round(maxTtft * CALIBRATION_BUFFER),
    targetMsPerChar: Math.round(maxMsPerChar * CALIBRATION_BUFFER * 100) / 100,
    targetTokensPerSecond: minRate != null ? Math.round((minRate / CALIBRATION_BUFFER) * 10) / 10 : null,
    samples,
    computedAt: Date.now(),
  };
}

// groupId -> in flight, so concurrent triggers (a lazy GET backfill racing a
// manual recalibrate) don't fire the same group's models twice at once.
const calibrating = new Set<string>();

// Read-modify-write against GROUPS_FILE, serialized (see withFileLock) so it
// can't race another group's concurrent read-modify-write. Returns the fresh
// array either way (fn may mutate it in place or push/splice into it).
function mutateGroups<T>(fn: (groups: Group[]) => T | Promise<T>): Promise<{ groups: Group[]; result: T }> {
  return withFileLock(GROUPS_FILE, async () => {
    const groups = await readJsonFile<Group[]>(GROUPS_FILE, []);
    const result = await fn(groups);
    await writeJsonFile(GROUPS_FILE, groups);
    return { groups, result };
  });
}

async function runGroupCalibration(groupId: string, modelIds: string[], apiKey: string) {
  if (!apiKey || calibrating.has(groupId)) return;
  calibrating.add(groupId);
  try {
    const { result: started } = await mutateGroups((groups) => {
      const g = groups.find((g) => g.id === groupId);
      if (!g) return false; // deleted before we started
      g.speedStatus = "pending";
      delete g.speedError;
      return true;
    });
    if (!started) return;

    const profile = await calibrateGroupSpeed(modelIds, apiKey);

    await mutateGroups((groups) => {
      const g = groups.find((g) => g.id === groupId);
      if (!g) return; // deleted while we were testing
      g.speedProfile = profile;
      g.speedStatus = "ready";
      delete g.speedError;
    });
  } catch (err) {
    await mutateGroups((groups) => {
      const g = groups.find((g) => g.id === groupId);
      if (g) {
        g.speedStatus = "error";
        g.speedError = String(err).slice(0, 300);
      }
    }).catch(() => {});
  } finally {
    calibrating.delete(groupId);
  }
}

/* ----------------------------------------------------------------- types */

type ChatRole = "user" | "assistant";

type MsgMeta = {
  requestedAt?: number;
  firstTokenMs?: number;
  totalMs?: number;
  finishReason?: string | null;
  nativeFinishReason?: string | null;
  usage?: Record<string, unknown> | null;
  reasoningTokens?: number | null;
  chunkCount?: number;
  /* private until reveal */
  modelId?: string;
  /* playground only: what this turn was actually sent with */
  requestedModel?: string;
  systemPrompt?: string;
  provider?: string;
  generationId?: string;
  cost?: number | null;
  generation?: Record<string, unknown> | null;
  error?: string;
};

type ChatMessage = {
  id: string;
  /** playground only: the message this one follows — messages form a tree of branches */
  parentId?: string | null;
  role: ChatRole;
  content: string;
  reasoning?: string;
  reasoningDetails?: unknown[];
  toolCalls?: unknown[];
  annotations?: unknown[];
  createdAt: number;
  meta?: MsgMeta;
};

type RoundSettings = { temperature: number; maxTokens: number; reasoning: "auto" | "low" | "medium" | "high" | "off" };

type Round = {
  id: string;
  seq: number;
  groupId: string;
  groupName: string;
  modelIds: string[];
  actualModel: string;
  actualModelName?: string;
  settings: RoundSettings;
  messages: ChatMessage[];
  guess: string | null;
  correct: boolean | null;
  guessedAt: number | null;
  revealed: boolean;
  createdAt: number;
  updatedAt: number;
};

type Group = {
  id: string;
  name: string;
  modelIds: string[];
  createdAt: number;
  updatedAt: number;
  speedProfile?: GroupSpeedProfile | null;
  speedStatus?: "idle" | "pending" | "ready" | "error";
  speedError?: string;
};

/* ------------------------------------------------------------- round i/o */

const roundFile = (id: string) => path.join(ROUNDS_DIR, `${id}.json`);
const logFile = (id: string) => path.join(LOGS_DIR, `${id}.jsonl`);

async function loadRound(id: string): Promise<Round | null> {
  const safe = safeId(id);
  if (!safe) return null;
  return readJsonFile<Round | null>(roundFile(safe), null);
}

async function saveRound(round: Round) {
  round.updatedAt = Date.now();
  await ensureDirs();
  await writeJsonFile(roundFile(round.id), round);
}

async function appendLog(id: string, entry: unknown) {
  await ensureDirs();
  await fs.appendFile(logFile(id), `${JSON.stringify({ t: Date.now(), ...(entry as object) })}\n`, "utf8");
}

// Usage objects carry vendor-shaped field names (cache_creation_input_tokens,
// image_tokens, ...) that fingerprint the provider without you having noticed a
// thing about the conversation. Pre-reveal we pass only the neutral counters.
const USAGE_KEYS = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;

function sanitizeUsage(usage: Record<string, unknown> | null | undefined, revealed: boolean) {
  if (!usage) return usage ?? null;
  if (revealed) return usage;
  const out: Record<string, unknown> = {};
  for (const k of USAGE_KEYS) if (usage[k] != null) out[k] = usage[k];
  const rt = (usage as any)?.completion_tokens_details?.reasoning_tokens;
  if (rt != null) out.reasoning_tokens = rt;
  return out;
}

// reasoning_details entries carry provider-tagged formats and signatures.
// Pre-reveal we keep only the shape, never the labels.
function sanitizeReasoningDetails(details: unknown[] | undefined, revealed: boolean) {
  if (!details) return undefined;
  if (revealed) return details;
  return details.map((d: any, i) => ({
    index: typeof d?.index === "number" ? d.index : i,
    hasText: typeof d?.text === "string" && d.text.length > 0,
    textLength: typeof d?.text === "string" ? d.text.length : 0,
    encrypted: Boolean(d?.signature || d?.data),
  }));
}

// What the browser is allowed to see. Hides the answer until the round is over.
function publicMessage(m: ChatMessage, revealed: boolean): ChatMessage {
  const meta = { ...(m.meta || {}) };
  meta.usage = sanitizeUsage(meta.usage, revealed) as Record<string, unknown> | null;
  if (!revealed) {
    delete meta.modelId;
    delete meta.provider;
    delete meta.generationId;
    delete meta.cost;
    delete meta.generation;
    // The native finish reason ("STOP" vs "end_turn" vs "stop") is a pure
    // provider fingerprint, so it stays sealed until the guess is in.
    delete meta.nativeFinishReason;
  }
  return {
    ...m,
    meta,
    // The stored message is the model's real, untouched output (see
    // streamMessage) — self-id names are masked only here, at the boundary
    // where a message is handed to the browser, live or replayed.
    content: maskSelfId(m.content),
    reasoning: m.reasoning ? maskSelfId(m.reasoning) : m.reasoning,
    toolCalls: m.toolCalls?.map((tc: any) => ({
      ...tc,
      function: { ...tc.function, name: maskSelfId(tc.function?.name || ""), arguments: maskSelfId(tc.function?.arguments || "") },
    })),
    reasoningDetails: sanitizeReasoningDetails(m.reasoningDetails, revealed),
  };
}

function publicRound(r: Round, opts: { messages?: boolean } = {}) {
  const base = {
    id: r.id,
    seq: r.seq,
    groupId: r.groupId,
    groupName: r.groupName,
    modelIds: r.modelIds,
    settings: r.settings,
    guess: r.guess,
    correct: r.correct,
    guessedAt: r.guessedAt,
    revealed: r.revealed,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messageCount: r.messages.length,
    userMessageCount: r.messages.filter((m) => m.role === "user").length,
    actualModel: r.revealed ? r.actualModel : null,
    actualModelName: r.revealed ? r.actualModelName : null,
  };
  if (opts.messages === false) return base;
  return { ...base, messages: r.messages.map((m) => publicMessage(m, r.revealed)) };
}

async function listRounds(): Promise<Round[]> {
  await ensureDirs();
  const files = (await fs.readdir(ROUNDS_DIR)).filter((f) => f.endsWith(".json"));
  const rounds: Round[] = [];
  for (const f of files) {
    const r = await readJsonFile<Round | null>(path.join(ROUNDS_DIR, f), null);
    if (r) rounds.push(r);
  }
  rounds.sort((a, b) => a.createdAt - b.createdAt);
  return rounds;
}

/* ------------------------------------------------------------- compare */

// Shared by compare and rooms: real identity hides behind a shuffled
// @model1, @model2, … handle — assigned fresh each time, so it can't be
// memorized across runs/rooms from the same group — until a guess reveals
// it, exactly like a round's hidden actualModel.
type BlindParticipant = { modelId: string; modelName?: string; handle: string };
type BlindGuess = { handle: string; guessedModelId: string; correct: boolean };

function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function assignHandles(modelIds: string[]): BlindParticipant[] {
  return shuffled(modelIds).map((modelId, i) => ({ modelId, handle: `model${i + 1}` }));
}
// Requires a guess for every participant and each guess to name one of this
// group's own models, then scores them — shared by compare's and rooms'
// guess routes.
function validateAndScoreGuesses(
  participants: BlindParticipant[],
  guesses: Record<string, unknown> | null | undefined,
): { ok: true; result: BlindGuess[] } | { ok: false; error: string } {
  const g = guesses && typeof guesses === "object" ? guesses : {};
  const missing = participants.filter((p) => !g[p.handle]);
  if (missing.length) {
    return { ok: false, error: `missing a guess for ${missing.map((p) => "@" + p.handle).join(", ")}` };
  }
  const validIds = new Set(participants.map((p) => p.modelId));
  for (const p of participants) {
    if (!validIds.has(String(g[p.handle]))) {
      return { ok: false, error: `guess for @${p.handle} isn't one of this group's models` };
    }
  }
  return {
    ok: true,
    result: participants.map((p) => {
      const guessedModelId = String(g[p.handle]);
      return { handle: p.handle, guessedModelId, correct: guessedModelId === p.modelId };
    }),
  };
}

/* -------------------------------------------------------------- compare */

// A different tool from the blind-test rounds above, but the same blind
// stance: nothing about identity is revealed until you guess. Every model
// in a group answers the same prompts, so you can see where they land
// relative to each other before deciding who's who. Responses are embedded
// (OpenAI) and compared by cosine distance so each answer can be tagged with
// how far it sits from the rest of the group's answers to that same prompt —
// the model that wandered off in its own direction stands out on its own,
// independent of (and visible before) the identity guess.

type CompareResponse = {
  handle: string;
  modelId?: string;
  modelName?: string;
  content: string;
  error?: string;
  totalMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  /** mean cosine distance to the group's other answers to this same prompt */
  avgDistance?: number | null;
};

type ComparePromptResult = {
  prompt: string;
  responses: CompareResponse[];
  embeddingError?: string;
};

type CompareRun = {
  id: string;
  groupId: string;
  groupName: string;
  participants: BlindParticipant[];
  prompts: string[];
  results: ComparePromptResult[];
  status: "running" | "done" | "error";
  error?: string;
  revealed: boolean;
  guesses: BlindGuess[] | null;
  createdAt: number;
  updatedAt: number;
};

const compareFile = (id: string) => path.join(COMPARE_DIR, `${id}.json`);

// Runs saved before this tab went blind have modelIds + per-response
// modelId/modelName instead of participants/handle, and no revealed/guesses
// at all. Reshape those in place on read rather than crashing or losing
// them — they were transparent when made, so they migrate in as already
// revealed, not retroactively blinded.
function migrateCompareRun(run: any): CompareRun {
  if (Array.isArray(run.participants)) {
    if (typeof run.revealed !== "boolean") run.revealed = false;
    if (run.guesses === undefined) run.guesses = null;
    return run as CompareRun;
  }
  const modelIds: string[] = Array.isArray(run.modelIds) ? run.modelIds : [];
  const handleByModelId = new Map(modelIds.map((id, i) => [id, `model${i + 1}`]));
  run.participants = modelIds.map((modelId: string) => ({ modelId, handle: handleByModelId.get(modelId) }));
  for (const pr of run.results || []) {
    for (const resp of pr.responses || []) {
      if (!resp.handle) resp.handle = handleByModelId.get(resp.modelId) || resp.modelId;
    }
  }
  delete run.modelIds;
  run.revealed = true; // this run was never blind to begin with
  run.guesses = null;
  return run as CompareRun;
}

async function loadCompareRun(id: string): Promise<CompareRun | null> {
  const safe = safeId(id);
  if (!safe) return null;
  const run = await readJsonFile<any | null>(compareFile(safe), null);
  return run ? migrateCompareRun(run) : null;
}
async function saveCompareRun(run: CompareRun) {
  run.updatedAt = Date.now();
  await ensureDirs();
  await writeJsonFile(compareFile(run.id), run);
}
async function listCompareRuns(): Promise<CompareRun[]> {
  await ensureDirs();
  const files = (await fs.readdir(COMPARE_DIR)).filter((f) => f.endsWith(".json"));
  const runs: CompareRun[] = [];
  for (const f of files) {
    const r = await readJsonFile<any | null>(path.join(COMPARE_DIR, f), null);
    if (r) runs.push(migrateCompareRun(r));
  }
  runs.sort((a, b) => a.createdAt - b.createdAt);
  return runs;
}
function publicCompareRun(r: CompareRun, opts: { results?: boolean } = {}) {
  const base = {
    id: r.id,
    groupId: r.groupId,
    groupName: r.groupName,
    // Real identity only travels once revealed — same stance as a round's
    // actualModel/actualModelName, or a room's participants.
    participants: r.participants.map((p) => ({
      handle: p.handle,
      modelId: r.revealed ? p.modelId : undefined,
      modelName: r.revealed ? p.modelName : undefined,
    })),
    promptCount: r.prompts.length,
    status: r.status,
    error: r.error,
    revealed: r.revealed,
    guesses: r.guesses,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (opts.results === false) return base;
  return {
    ...base,
    prompts: r.prompts,
    results: r.results.map((pr) => ({
      ...pr,
      responses: pr.responses.map((resp) => ({
        ...resp,
        modelId: r.revealed ? resp.modelId : undefined,
        modelName: r.revealed ? resp.modelName : undefined,
        // Self-identification is masked permanently, same as rounds and
        // rooms — not just pre-reveal, since revealing the handle mapping
        // doesn't require unmasking a model's own words.
        content: maskSelfId(resp.content),
      })),
    })),
  };
}

// Shared non-streaming OpenRouter call, used by both compare (one prompt) and
// rooms (a full multi-party transcript) — anywhere a complete reply is
// needed up front rather than streamed to a browser live.
async function postChatCompletion(
  modelId: string,
  messages: { role: string; content: string }[],
  apiKey: string,
  opts: { temperature?: number; maxTokens?: number; title?: string; excludeReasoning?: boolean } = {},
): Promise<{ content: string; error?: string; totalMs?: number; usage?: any }> {
  const started = Date.now();
  try {
    const body: Record<string, unknown> = {
      model: modelId,
      stream: false,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 500,
      messages,
      provider: await providerRouting(modelId),
    };
    // Some models (notably Gemini) default to spending part of max_tokens on
    // hidden thinking before the visible reply — with a small budget that
    // silently truncates the answer we actually show. Callers that don't
    // display reasoning can opt out of it entirely to keep the whole budget
    // for visible content.
    if (opts.excludeReasoning) body.reasoning = { exclude: true };
    const r = await fetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5199",
        "X-Title": opts.title || "blind-test",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { content: "", error: `${r.status} ${text.slice(0, 250)}`, totalMs: Date.now() - started };
    }
    const data = (await r.json()) as any;
    const content = data?.choices?.[0]?.message?.content ?? "";
    return { content, totalMs: Date.now() - started, usage: data?.usage };
  } catch (err) {
    return { content: "", error: String(err).slice(0, 250), totalMs: Date.now() - started };
  }
}

function fetchModelReply(modelId: string, prompt: string, apiKey: string) {
  return postChatCompletion(modelId, [{ role: "user", content: prompt }], apiKey, {
    title: "blind-test (compare)",
    maxTokens: 1600,
    excludeReasoning: true,
  });
}

async function embedTexts(texts: string[], openaiApiKey: string): Promise<number[][]> {
  const r = await fetch(`${OPENAI}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = (await r.json()) as { data: { embedding: number[]; index: number }[] };
  return [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? 1 - dot / denom : 1;
}

// For each response, its mean cosine distance to every *other* response in
// the same prompt's cohort. Low = reads like the group's consensus. High =
// the outlier.
function averageDistances(vectors: (number[] | null)[]): (number | null)[] {
  return vectors.map((v, i) => {
    if (!v) return null;
    const dists: number[] = [];
    vectors.forEach((w, j) => {
      if (i !== j && w) dists.push(cosineDistance(v, w));
    });
    return dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null;
  });
}

async function runCompare(runId: string, apiKey: string, openaiApiKey: string) {
  const run = await loadCompareRun(runId);
  if (!run) return;
  try {
    for (const prompt of run.prompts) {
      const replies = await Promise.all(run.participants.map((p) => fetchModelReply(p.modelId, prompt, apiKey)));
      const responses: CompareResponse[] = replies.map((rep, i) => ({
        handle: run.participants[i].handle,
        modelId: run.participants[i].modelId,
        modelName: run.participants[i].modelName,
        content: rep.content,
        error: rep.error,
        totalMs: rep.totalMs,
        usage: rep.usage ? { prompt_tokens: rep.usage.prompt_tokens, completion_tokens: rep.usage.completion_tokens } : null,
      }));

      const promptResult: ComparePromptResult = { prompt, responses };
      const embeddable = responses.filter((r) => !r.error && r.content.trim());
      if (openaiApiKey && embeddable.length >= 2) {
        try {
          const vectors = await embedTexts(
            embeddable.map((r) => r.content),
            openaiApiKey,
          );
          let vi = 0;
          const perResponseVector: (number[] | null)[] = responses.map((r) =>
            !r.error && r.content.trim() ? vectors[vi++] : null,
          );
          const avgs = averageDistances(perResponseVector);
          responses.forEach((r, i) => (r.avgDistance = avgs[i]));
        } catch (err) {
          promptResult.embeddingError = String(err instanceof Error ? err.message : err).slice(0, 300);
        }
      } else if (!openaiApiKey) {
        promptResult.embeddingError = "No OPENAI_API_KEY on the server — showing raw responses only.";
      }

      run.results.push(promptResult);
      await saveCompareRun(run);
    }
    run.status = "done";
    await saveCompareRun(run);
  } catch (err) {
    run.status = "error";
    run.error = String(err instanceof Error ? err.message : err).slice(0, 400);
    await saveCompareRun(run).catch(() => {});
  }
}

/* ---------------------------------------------------------------- rooms */

// A third tool, alongside blind-test rounds and compare: a group chat with
// every model in a group as a named participant, plus you. Nothing is
// hidden — same transparency stance as compare. You address the whole room
// with @models or specific participants with @handle; a model mentioning
// another participant's handle in its own reply is what brings that
// participant into the conversation too, cascading (bounded per-room by
// Room.maxCascade, set at creation) until nobody more gets mentioned.

const ROOM_MAX_CASCADE_DEFAULT = 12; // fallback + default when a room doesn't set its own
const ROOM_MAX_CASCADE_MIN = 1;
const ROOM_MAX_CASCADE_MAX = 50;
const ROOM_HISTORY_WINDOW = 40; // messages of context sent to a model, most recent — full history is still kept and shown
const ROOM_MENTION_ALL = new Set(["models", "all", "everyone"]);

function clampMaxCascade(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return ROOM_MAX_CASCADE_DEFAULT;
  return Math.min(ROOM_MAX_CASCADE_MAX, Math.max(ROOM_MAX_CASCADE_MIN, v));
}

type RoomMessage = {
  id: string;
  role: "user" | "model";
  handle: string; // "you" for the human, else the participant's handle
  modelId?: string;
  content: string;
  error?: string;
  createdAt: number;
  meta?: { totalMs?: number; usage?: { prompt_tokens?: number; completion_tokens?: number } | null };
};

type Room = {
  id: string;
  groupId: string;
  groupName: string;
  participants: BlindParticipant[];
  rulesPrompt: string; // generic, shown in the UI — the personalized version each model actually gets is built from this per reply
  messages: RoomMessage[];
  processing: boolean;
  error?: string;
  revealed: boolean;
  guesses: BlindGuess[] | null;
  /** hard cap on model replies triggered by one send — set at room creation */
  maxCascade: number;
  createdAt: number;
  updatedAt: number;
};

function genericRulesPrompt(participants: BlindParticipant[]): string {
  const roster = participants.map((p) => `@${p.handle}`).join(", ");
  return (
    `This is a blind group chat between you and ${participants.length} AI model${participants.length === 1 ? "" : "s"}, identified only by handle: ${roster}. Which real model is behind which handle is hidden until you guess.\n` +
    `Address everyone with @models, or bring in specific participants by name, e.g. @${participants[0]?.handle || "handle"}.\n` +
    `Mentioning a participant — including one model mentioning another — is what invites them to reply, so only do it when you actually want them to weigh in.`
  );
}

function personalizedRulesPrompt(self: BlindParticipant, participants: BlindParticipant[]): string {
  const others = participants.filter((p) => p.handle !== self.handle);
  const roster = participants.map((p) => `@${p.handle}`).join(", ");
  const exampleOther = others[0]?.handle || "another-handle";
  return (
    `You are participating in a group chat alongside a human and other AI models. You are @${self.handle}.\n` +
    `All participants: ${roster}.\n` +
    `Other participants' messages are shown to you prefixed with their handle, like "[${exampleOther}]: their message". The human's messages are prefixed "[human]:". Your own prior turns appear unprefixed, as your own messages.\n` +
    `To address the whole room, someone writes @models. To bring a specific participant into the conversation, mention their handle, e.g. @${exampleOther} — that includes you mentioning another model if you want their take, or the reverse. Only mention a handle when you actually want that participant to reply next; you don't need to mention anyone to just answer directly.\n` +
    `This is a blind test: the human is trying to guess which real AI model is behind each handle. Don't state or hint at what model, company, or vendor you are — no self-identification, and don't guess at other participants' identities either.\n` +
    `Reply naturally and stay on topic.`
  );
}

// @models / @all / @everyone means every participant; otherwise only known
// handles (case-insensitive) count — a stray "@" or typo is just text.
function parseMentions(text: string, participants: BlindParticipant[]): { all: boolean; handles: string[] } {
  const known = new Map(participants.map((p) => [p.handle.toLowerCase(), p.handle]));
  const found = [...text.matchAll(/@([a-zA-Z][\w.-]*)/g)].map((m) => m[1].toLowerCase());
  let all = false;
  const specific = new Set<string>();
  for (const f of found) {
    if (ROOM_MENTION_ALL.has(f)) all = true;
    else if (known.has(f)) specific.add(known.get(f)!);
  }
  return { all, handles: all ? participants.map((p) => p.handle) : [...specific] };
}

function buildRoomPayload(self: BlindParticipant, room: Room): { role: string; content: string }[] {
  const history = room.messages.slice(-ROOM_HISTORY_WINDOW);
  const messages: { role: string; content: string }[] = [
    { role: "system", content: personalizedRulesPrompt(self, room.participants) },
  ];
  for (const m of history) {
    if (m.role === "user") messages.push({ role: "user", content: `[human]: ${m.content}` });
    else if (m.modelId === self.modelId) messages.push({ role: "assistant", content: m.content });
    else messages.push({ role: "user", content: `[${m.handle}]: ${m.content}` });
  }
  return messages;
}

const roomFile = (id: string) => path.join(ROOM_DIR, `${id}.json`);
async function loadRoom(id: string): Promise<Room | null> {
  const safe = safeId(id);
  if (!safe) return null;
  return readJsonFile<Room | null>(roomFile(safe), null);
}
async function saveRoom(room: Room) {
  room.updatedAt = Date.now();
  await ensureDirs();
  await writeJsonFile(roomFile(room.id), room);
}
async function listAllRooms(): Promise<Room[]> {
  await ensureDirs();
  const files = (await fs.readdir(ROOM_DIR)).filter((f) => f.endsWith(".json"));
  const rooms: Room[] = [];
  for (const f of files) {
    const r = await readJsonFile<Room | null>(path.join(ROOM_DIR, f), null);
    if (r) rooms.push(r);
  }
  rooms.sort((a, b) => a.createdAt - b.createdAt);
  return rooms;
}
function publicRoom(r: Room, opts: { messages?: boolean } = {}) {
  const base = {
    id: r.id,
    groupId: r.groupId,
    groupName: r.groupName,
    // Real identity only travels once revealed — same stance as a round's
    // actualModel/actualModelName.
    participants: r.participants.map((p) => ({
      handle: p.handle,
      modelId: r.revealed ? p.modelId : undefined,
      modelName: r.revealed ? p.modelName : undefined,
    })),
    rulesPrompt: r.rulesPrompt,
    processing: r.processing,
    error: r.error,
    revealed: r.revealed,
    guesses: r.guesses,
    maxCascade: clampMaxCascade(r.maxCascade),
    messageCount: r.messages.length,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (opts.messages === false) return base;
  return {
    ...base,
    messages: r.messages.map((m) => ({
      ...m,
      modelId: r.revealed ? m.modelId : undefined,
      // Self-identification is masked the same way rounds mask it, and for
      // the same reason: permanently, not just pre-reveal — nothing about
      // revealing the mapping requires unmasking a model's own words.
      content: m.role === "model" ? maskSelfId(m.content) : m.content,
    })),
  };
}

// Processes one send: the mentions on the just-added message seed the
// queue; each reply's own mentions can add more, up to the room's
// maxCascade total replies. Runs in the background — see the route handler.
async function runRoomTurn(roomId: string, apiKey: string, seedHandles: string[]) {
  const room = await loadRoom(roomId);
  if (!room) return;
  try {
    const queue = [...seedHandles];
    const queued = new Set(seedHandles);
    let budget = clampMaxCascade(room.maxCascade);
    while (queue.length && budget > 0) {
      const handle = queue.shift()!;
      queued.delete(handle);
      const participant = room.participants.find((p) => p.handle === handle);
      if (!participant) continue;
      budget--;

      const reply = await postChatCompletion(participant.modelId, buildRoomPayload(participant, room), apiKey, {
        title: "blind-test (room)",
        maxTokens: 600,
      });
      room.messages.push({
        id: newId("rmsg"),
        role: "model",
        handle: participant.handle,
        modelId: participant.modelId,
        content: reply.content,
        error: reply.error,
        createdAt: Date.now(),
        meta: { totalMs: reply.totalMs, usage: reply.usage ? { prompt_tokens: reply.usage.prompt_tokens, completion_tokens: reply.usage.completion_tokens } : null },
      });
      await saveRoom(room);

      if (!reply.error && reply.content) {
        const { handles } = parseMentions(reply.content, room.participants);
        for (const h of handles) {
          if (h === participant.handle || queued.has(h)) continue; // no self-trigger, no double-queue
          queue.push(h);
          queued.add(h);
        }
      }
    }
    room.processing = false;
    await saveRoom(room);
  } catch (err) {
    room.processing = false;
    room.error = String(err instanceof Error ? err.message : err).slice(0, 400);
    await saveRoom(room).catch(() => {});
  }
}

/* ---------------------------------------------------------- playground */

// A plain, un-blinded chat: you pick the model and the system prompt, and
// nothing is masked, throttled or sealed. Model, system prompt and settings
// can all change between turns — every assistant message records the model
// and system prompt it was actually generated with.
type PlaygroundChat = {
  id: string;
  title: string;
  modelId: string;
  systemPrompt: string;
  settings: RoundSettings;
  /** Every message on every branch; each points at its parent. */
  messages: ChatMessage[];
  /** The last message of the branch you're looking at. Absent on chats saved before branching. */
  headId?: string | null;
  /** Your notes on the transcript. Absent on chats saved before comments existed. */
  comments?: ChatComment[];
  /** Show thinking folded away instead of inline above the answer. Absent = inline. */
  collapseThinking?: boolean;
  createdAt: number;
  updatedAt: number;
};

// A note anchored to a stretch of one message's rendered text. The anchor is
// the quoted text plus a little context either side (not character offsets),
// so it survives markdown rendering and still finds its place on reload.
// Messages are never deleted any more (regenerate adds a branch), but chats
// from before branching may hold comments on a reply that retry dropped — kept.
type ChatComment = {
  id: string;
  messageId: string;
  field: "content" | "reasoning";
  quote: string;
  prefix: string;
  suffix: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};

const chatFile = (id: string) => path.join(CHATS_DIR, `${id}.json`);
const chatLogFile = (id: string) => path.join(CHAT_LOGS_DIR, `${id}.jsonl`);
const REASONING_LEVELS = new Set(["auto", "off", "low", "medium", "high"]);

async function loadChat(id: string): Promise<PlaygroundChat | null> {
  const safe = safeId(id);
  if (!safe) return null;
  const chat = await readJsonFile<PlaygroundChat | null>(chatFile(safe), null);
  return chat && treeify(chat);
}

// Chats saved before branching are a plain list: each message follows the
// one before it. Fill that in (in memory — the file only changes when the
// chat next does) so every chat is a tree with a current branch.
function treeify(chat: PlaygroundChat): PlaygroundChat {
  let prev: string | null = null;
  for (const m of chat.messages) {
    if (m.parentId === undefined) m.parentId = prev;
    prev = m.id;
  }
  if (!chat.headId || !chat.messages.some((m) => m.id === chat.headId)) chat.headId = prev;
  return chat;
}

/** Root-to-message path through the tree: the conversation as that branch sees it. */
function chatPath(chat: PlaygroundChat, leafId: string | null | undefined): ChatMessage[] {
  const byId = new Map(chat.messages.map((m) => [m.id, m]));
  const out: ChatMessage[] = [];
  const seen = new Set<string>();
  for (let m = leafId ? byId.get(leafId) : undefined; m && !seen.has(m.id); m = m.parentId ? byId.get(m.parentId) : undefined) {
    seen.add(m.id);
    out.push(m);
  }
  return out.reverse();
}

async function saveChat(chat: PlaygroundChat) {
  chat.updatedAt = Date.now();
  await ensureDirs();
  await writeJsonFile(chatFile(chat.id), chat);
}

// Re-read, change, write — under the file's lock, so the background
// generation-stats merge can't clobber a turn that landed in the meantime.
function mutateChat(id: string, fn: (chat: PlaygroundChat) => void): Promise<PlaygroundChat | null> {
  return withFileLock(chatFile(id), async () => {
    const chat = await loadChat(id);
    if (!chat) return null;
    fn(chat);
    await saveChat(chat);
    return chat;
  });
}

async function appendChatLog(id: string, entry: unknown) {
  await ensureDirs();
  await fs.appendFile(chatLogFile(id), `${JSON.stringify({ t: Date.now(), ...(entry as object) })}\n`, "utf8");
}

async function listChats(): Promise<PlaygroundChat[]> {
  await ensureDirs();
  const files = (await fs.readdir(CHATS_DIR)).filter((f) => f.endsWith(".json"));
  const all = await Promise.all(files.map((f) => readJsonFile<PlaygroundChat | null>(path.join(CHATS_DIR, f), null)));
  return all.filter((c): c is PlaygroundChat => Boolean(c)).sort((a, b) => b.updatedAt - a.updatedAt);
}

function publicChat(c: PlaygroundChat, opts: { messages?: boolean } = {}) {
  const { messages, ...base } = c;
  const out = { ...base, comments: c.comments ?? [], messageCount: messages.length };
  return opts.messages === false ? out : { ...out, messages };
}

// Replies still streaming: not saved to their chat yet, but already open for comments.
const streamingReplies = new Set<string>();

type ChatConfig = {
  modelId?: string;
  systemPrompt?: string;
  settings?: Partial<RoundSettings>;
  title?: string;
  collapseThinking?: boolean;
};

// Normalizes a config patch from the browser and checks a model id against the
// live catalogue. Returns an error string instead of throwing.
async function parseChatConfig(body: any): Promise<{ config: ChatConfig } | { error: string; suggestions?: string[] }> {
  const config: ChatConfig = {};
  if (body.modelId !== undefined) {
    const id = String(body.modelId).trim();
    if (!id) return { error: "pick a model" };
    const [check] = await validateIds([id]);
    if (!check?.valid) return { error: `unknown model id: ${id}`, suggestions: check?.suggestions };
    config.modelId = id;
  }
  if (body.systemPrompt !== undefined) config.systemPrompt = String(body.systemPrompt);
  if (body.title !== undefined) config.title = String(body.title).trim().slice(0, 120);
  if (body.collapseThinking !== undefined) config.collapseThinking = Boolean(body.collapseThinking);
  if (body.settings && typeof body.settings === "object") {
    const st: Partial<RoundSettings> = {};
    const t = Number(body.settings.temperature);
    if (body.settings.temperature !== undefined && Number.isFinite(t)) st.temperature = Math.min(2, Math.max(0, t));
    const mt = Math.round(Number(body.settings.maxTokens));
    if (body.settings.maxTokens !== undefined && Number.isFinite(mt)) st.maxTokens = Math.max(1, mt);
    if (REASONING_LEVELS.has(body.settings.reasoning)) st.reasoning = body.settings.reasoning;
    config.settings = st;
  }
  return { config };
}

// Applies a parsed config and logs only what actually changed.
function applyChatConfig(chat: PlaygroundChat, config: ChatConfig): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  if (config.modelId !== undefined && config.modelId !== chat.modelId) chat.modelId = changed.modelId = config.modelId;
  if (config.systemPrompt !== undefined && config.systemPrompt !== chat.systemPrompt)
    chat.systemPrompt = changed.systemPrompt = config.systemPrompt;
  if (config.title !== undefined && config.title !== chat.title) chat.title = changed.title = config.title;
  if (config.collapseThinking !== undefined && config.collapseThinking !== Boolean(chat.collapseThinking))
    chat.collapseThinking = changed.collapseThinking = config.collapseThinking;
  if (config.settings) {
    const next = { ...chat.settings, ...config.settings };
    if (JSON.stringify(next) !== JSON.stringify(chat.settings)) chat.settings = changed.settings = next;
  }
  return changed;
}

/* --------------------------------------------------------------- plugin */

function blindTestApi(apiKey: string, keySource: string, openaiApiKey: string): Plugin {
  return {
    name: "blind-test-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/api/")) return next();

        const pathname = decodeURIComponent(url.split("?")[0]);
        const query = new URLSearchParams(url.split("?")[1] || "");
        const seg = pathname.replace(/^\/api\//, "").split("/");
        const method = req.method || "GET";

        try {
          await ensureDirs();

          /* ---- status ---- */
          if (seg[0] === "status" && method === "GET") {
            return json(res, 200, { hasKey: Boolean(apiKey), keySource, hasOpenAiKey: Boolean(openaiApiKey) });
          }

          /* ---- catalog ---- */
          if (seg[0] === "catalog") {
            if (seg[1] === "validate" && method === "POST") {
              const { ids } = await readBody(req);
              if (!Array.isArray(ids)) return json(res, 400, { error: "ids must be an array" });
              return json(res, 200, { results: await validateIds(ids.slice(0, 200)) });
            }
            if (seg[1] === "search" && method === "GET") {
              const cat = await fetchCatalog();
              const q = (query.get("q") || "").toLowerCase().trim();
              const hits = q
                ? cat.models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
                : cat.models;
              return json(res, 200, {
                fetchedAt: cat.fetchedAt,
                total: cat.models.length,
                models: hits.slice(0, 40).map((m) => ({ id: m.id, name: m.name, context_length: m.context_length })),
              });
            }
            if (method === "GET") {
              const cat = await fetchCatalog(query.get("refresh") === "1");
              return json(res, 200, { fetchedAt: cat.fetchedAt, count: cat.models.length });
            }
          }

          /* ---- providers ---- */
          if (seg[0] === "providers") {
            const describe = async (modelId: string, force = false) => {
              let endpoints: ProviderEndpoint[] = [];
              let error: string | undefined;
              try {
                endpoints = await fetchEndpoints(modelId, force);
              } catch (err) {
                error = String(err instanceof Error ? err.message : err);
              }
              const pin = await resolvePin(modelId);
              return {
                modelId,
                pin,
                recommended: pickDefaultEndpoint(modelId, endpoints)?.tag ?? null,
                pinAvailable: pin ? endpoints.some((e) => e.tag === pin.tag) : null,
                endpoints,
                error,
              };
            };
            if (method === "GET") {
              const modelId = (query.get("model") || "").trim();
              if (!modelId) return json(res, 400, { error: "model is required" });
              return json(res, 200, await describe(modelId, query.get("refresh") === "1"));
            }
            if (method === "POST") {
              const body = await readBody(req);
              const modelId = String(body.modelId || "").trim();
              if (!modelId) return json(res, 400, { error: "modelId is required" });
              const before = (await readPins())[modelId]?.tag;
              if (body.tag == null) {
                // Back to the default: drop the pin and let resolvePin choose afresh.
                await mutatePins((p) => {
                  delete p[modelId];
                });
              } else {
                const tag = String(body.tag);
                const endpoint = (await fetchEndpoints(modelId, true)).find((e) => e.tag === tag);
                if (!endpoint) return json(res, 400, { error: `${tag} doesn't serve ${modelId}` });
                await mutatePins((p) => {
                  p[modelId] = { tag, name: endpoint.name, auto: false, pinnedAt: Date.now() };
                });
              }
              const out = await describe(modelId);
              // A different host means a different pace: every group with this
              // model has a stale speed profile now.
              if (apiKey && out.pin?.tag !== before) {
                const { groups } = await mutateGroups((groups) => {
                  for (const g of groups) if (g.modelIds.includes(modelId)) g.speedStatus = "pending";
                });
                for (const g of groups)
                  if (g.modelIds.includes(modelId)) void runGroupCalibration(g.id, g.modelIds, apiKey);
              }
              return json(res, 200, out);
            }
          }

          /* ---- groups ---- */
          if (seg[0] === "groups") {
            if (!seg[1] && method === "GET") {
              const groups = await readJsonFile<Group[]>(GROUPS_FILE, []);
              // Backfill: a group that has NEVER been speed-tested (no status at
              // all — imported, hand-edited into groups.json, or created before
              // this feature shipped) gets one test, lazily, once. A group whose
              // last test errored is deliberately left alone here — the UI's
              // "retry" link drives that, so a standing failure (bad key, model
              // down) can't turn into a call every 2s while the page polls.
              if (apiKey) {
                for (const g of groups) {
                  if (!g.speedProfile && !g.speedStatus && g.modelIds.length >= 2) {
                    void runGroupCalibration(g.id, g.modelIds, apiKey);
                  }
                }
              }
              return json(res, 200, { groups });
            }
            if (!seg[1] && method === "POST") {
              const body = await readBody(req);
              const name = String(body.name || "").trim();
              const modelIds: string[] = Array.isArray(body.modelIds)
                ? [...new Set<string>(body.modelIds.map((s: unknown) => String(s).trim()).filter(Boolean))]
                : [];
              if (!name) return json(res, 400, { error: "name is required" });
              if (modelIds.length < 2) return json(res, 400, { error: "a group needs at least 2 models" });
              const results = await validateIds(modelIds);
              const bad = results.filter((r) => !r.valid);
              if (bad.length) return json(res, 400, { error: "invalid model ids", results });

              let targetId = "";
              let needsCalibration = false;
              const { groups } = await mutateGroups((groups) => {
                const now = Date.now();
                const existing = body.id ? groups.find((g) => g.id === body.id) : null;
                // Only worth re-testing speed when the line-up itself changed (or
                // has never been tested) — a bare rename shouldn't cost API calls.
                if (existing) {
                  needsCalibration = existing.modelIds.join("|") !== modelIds.join("|") || !existing.speedProfile;
                  existing.name = name;
                  existing.modelIds = modelIds;
                  existing.updatedAt = now;
                  if (needsCalibration) existing.speedStatus = "pending";
                  targetId = existing.id;
                } else {
                  const g: Group = { id: newId("grp"), name, modelIds, createdAt: now, updatedAt: now, speedStatus: "pending" };
                  groups.push(g);
                  targetId = g.id;
                  needsCalibration = true;
                }
              });
              // Save returns immediately; the speed test runs in the background and
              // the group picks up its profile a few seconds later (see GET /groups).
              if (needsCalibration && apiKey) void runGroupCalibration(targetId, modelIds, apiKey);
              return json(res, 200, { groups, results });
            }
            if (seg[1] && seg[2] === "calibrate" && method === "POST") {
              if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });
              let found = false;
              let modelIds: string[] = [];
              const { groups } = await mutateGroups((groups) => {
                const group = groups.find((g) => g.id === seg[1]);
                if (!group) return;
                found = true;
                modelIds = group.modelIds;
                group.speedStatus = "pending";
                delete group.speedError;
              });
              if (!found) return json(res, 404, { error: "group not found" });
              void runGroupCalibration(seg[1]!, modelIds, apiKey);
              return json(res, 200, { groups });
            }
            if (seg[1] && method === "DELETE") {
              const { groups } = await mutateGroups((groups) => {
                const idx = groups.findIndex((g) => g.id === seg[1]);
                if (idx >= 0) groups.splice(idx, 1);
              });
              return json(res, 200, { groups });
            }
          }

          /* ---- rounds ---- */
          if (seg[0] === "rounds") {
            if (!seg[1] && method === "GET") {
              const all = await listRounds();
              const withMessages = query.get("messages") === "1";
              return json(res, 200, { rounds: all.map((r) => publicRound(r, { messages: withMessages })) });
            }

            if (!seg[1] && method === "POST") {
              if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });
              const { groupId } = await readBody(req);
              const groups = await readJsonFile<Group[]>(GROUPS_FILE, []);
              const group = groups.find((g) => g.id === groupId);
              if (!group) return json(res, 404, { error: "group not found" });
              if (group.modelIds.length < 2) return json(res, 400, { error: "group needs at least 2 models" });

              const pick = group.modelIds[Math.floor(Math.random() * group.modelIds.length)];
              const cat = await fetchCatalog().catch(() => null);
              const entry = cat ? catalogIndex(cat).get(pick.toLowerCase()) : undefined;
              const all = await listRounds();
              const now = Date.now();
              const round: Round = {
                id: newId("rnd"),
                seq: all.length + 1,
                groupId: group.id,
                groupName: group.name,
                modelIds: [...group.modelIds],
                actualModel: pick,
                actualModelName: entry?.name,
                settings: {
                  temperature: 1,
                  maxTokens: 1600,
                  reasoning: "auto",
                },
                messages: [],
                guess: null,
                correct: null,
                guessedAt: null,
                revealed: false,
                createdAt: now,
                updatedAt: now,
              };
              await saveRound(round);
              await appendLog(round.id, {
                event: "round.created",
                groupId: group.id,
                groupName: group.name,
                candidates: group.modelIds,
                actualModel: pick,
              });
              return json(res, 200, { round: publicRound(round) });
            }

            const rid = seg[1] ? safeId(seg[1]) : null;
            if (rid) {
              const round = await loadRound(rid);
              if (!round) return json(res, 404, { error: "round not found" });

              if (!seg[2] && method === "GET") return json(res, 200, { round: publicRound(round) });

              if (!seg[2] && method === "DELETE") {
                await fs.rm(roundFile(rid), { force: true });
                await fs.rm(logFile(rid), { force: true });
                return json(res, 200, { ok: true });
              }

              if (seg[2] === "settings" && method === "POST") {
                const body = await readBody(req);
                round.settings = { ...round.settings, ...body };
                await saveRound(round);
                return json(res, 200, { round: publicRound(round) });
              }

              if (seg[2] === "guess" && method === "POST") {
                if (round.revealed) return json(res, 409, { error: "round already guessed" });
                const { guess } = await readBody(req);
                if (!round.modelIds.includes(guess)) return json(res, 400, { error: "guess not in this group" });
                round.guess = guess;
                round.correct = guess === round.actualModel;
                round.guessedAt = Date.now();
                round.revealed = true;
                await saveRound(round);
                await appendLog(round.id, {
                  event: "round.guess",
                  guess,
                  actualModel: round.actualModel,
                  correct: round.correct,
                });
                return json(res, 200, { round: publicRound(round) });
              }

              if (seg[2] === "log" && method === "GET") {
                if (!round.revealed) return json(res, 403, { error: "raw log unlocks after you guess" });
                let raw = "";
                try {
                  raw = await fs.readFile(logFile(rid), "utf8");
                } catch {
                  raw = "";
                }
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                return res.end(raw);
              }

              if (seg[2] === "message" && method === "POST") {
                return streamMessage(req, res, round, apiKey);
              }
            }
          }

          /* ---- compare ---- */
          if (seg[0] === "compare") {
            if (!seg[1] && method === "GET") {
              const runs = await listCompareRuns();
              return json(res, 200, { runs: runs.map((r) => publicCompareRun(r, { results: false })) });
            }
            if (!seg[1] && method === "POST") {
              if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });
              // No OPENAI_API_KEY still runs — runCompare just skips embedding and
              // distance-ranking, and each prompt's result says so.
              const body = await readBody(req);
              const groups = await readJsonFile<Group[]>(GROUPS_FILE, []);
              const group = groups.find((g) => g.id === body.groupId);
              if (!group) return json(res, 404, { error: "group not found" });
              const prompts: string[] = Array.isArray(body.prompts)
                ? body.prompts.map((s: unknown) => String(s).trim()).filter(Boolean)
                : String(body.prompts || "")
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean);
              if (!prompts.length) return json(res, 400, { error: "at least one prompt is required" });
              if (prompts.length > 30) return json(res, 400, { error: "30 prompts max per run" });

              const cat = await fetchCatalog().catch(() => null);
              const byId = cat ? catalogIndex(cat) : null;
              const participants = assignHandles(group.modelIds).map((p) => ({
                ...p,
                modelName: byId?.get(p.modelId.toLowerCase())?.name,
              }));

              const now = Date.now();
              const run: CompareRun = {
                id: newId("cmp"),
                groupId: group.id,
                groupName: group.name,
                participants,
                prompts,
                results: [],
                status: "running",
                revealed: false,
                guesses: null,
                createdAt: now,
                updatedAt: now,
              };
              await saveCompareRun(run);
              void runCompare(run.id, apiKey, openaiApiKey);
              return json(res, 200, { run: publicCompareRun(run) });
            }
            const cid = seg[1] ? safeId(seg[1]) : null;
            if (cid) {
              if (!seg[2] && method === "GET") {
                const run = await loadCompareRun(cid);
                if (!run) return json(res, 404, { error: "compare run not found" });
                return json(res, 200, { run: publicCompareRun(run) });
              }
              if (!seg[2] && method === "DELETE") {
                await fs.rm(compareFile(cid), { force: true });
                return json(res, 200, { ok: true });
              }
              if (seg[2] === "guess" && method === "POST") {
                const run = await loadCompareRun(cid);
                if (!run) return json(res, 404, { error: "compare run not found" });
                if (run.revealed) return json(res, 409, { error: "run already revealed" });
                const body = await readBody(req);
                const scored = validateAndScoreGuesses(run.participants, body.guesses);
                if (!scored.ok) return json(res, 400, { error: scored.error });
                run.guesses = scored.result;
                run.revealed = true;
                await saveCompareRun(run);
                return json(res, 200, { run: publicCompareRun(run) });
              }
            }
          }

          /* ---- rooms ---- */
          if (seg[0] === "rooms") {
            if (!seg[1] && method === "GET") {
              const rooms = await listAllRooms();
              return json(res, 200, { rooms: rooms.map((r) => publicRoom(r, { messages: false })) });
            }
            if (!seg[1] && method === "POST") {
              if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });
              const body = await readBody(req);
              const groups = await readJsonFile<Group[]>(GROUPS_FILE, []);
              const group = groups.find((g) => g.id === body.groupId);
              if (!group) return json(res, 404, { error: "group not found" });
              if (group.modelIds.length < 2) return json(res, 400, { error: "group needs at least 2 models" });

              const cat = await fetchCatalog().catch(() => null);
              const byId = cat ? catalogIndex(cat) : null;
              const participants = assignHandles(group.modelIds).map((p) => ({
                ...p,
                modelName: byId?.get(p.modelId.toLowerCase())?.name,
              }));

              const now = Date.now();
              const room: Room = {
                id: newId("room"),
                groupId: group.id,
                groupName: group.name,
                participants,
                rulesPrompt: genericRulesPrompt(participants),
                messages: [],
                processing: false,
                revealed: false,
                guesses: null,
                maxCascade: body.maxCascade == null ? ROOM_MAX_CASCADE_DEFAULT : clampMaxCascade(body.maxCascade),
                createdAt: now,
                updatedAt: now,
              };
              await saveRoom(room);
              return json(res, 200, { room: publicRoom(room) });
            }
            const roomId = seg[1] ? safeId(seg[1]) : null;
            if (roomId) {
              if (!seg[2] && method === "GET") {
                const room = await loadRoom(roomId);
                if (!room) return json(res, 404, { error: "room not found" });
                return json(res, 200, { room: publicRoom(room) });
              }
              if (!seg[2] && method === "DELETE") {
                await fs.rm(roomFile(roomId), { force: true });
                return json(res, 200, { ok: true });
              }
              if (seg[2] === "message" && method === "POST") {
                if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });
                const room = await loadRoom(roomId);
                if (!room) return json(res, 404, { error: "room not found" });
                if (room.revealed) return json(res, 409, { error: "room already revealed — start a new one" });
                if (room.processing) return json(res, 409, { error: "the room is still replying — wait for it to finish" });
                const body = await readBody(req);
                const content = String(body.content ?? "").trim();
                if (!content) return json(res, 400, { error: "empty message" });

                room.messages.push({ id: newId("rmsg"), role: "user", handle: "you", content, createdAt: Date.now() });
                const { handles } = parseMentions(content, room.participants);
                if (handles.length) {
                  room.processing = true;
                  room.error = undefined;
                }
                await saveRoom(room);
                if (handles.length) void runRoomTurn(room.id, apiKey, handles);
                return json(res, 200, { room: publicRoom(room) });
              }
              if (seg[2] === "guess" && method === "POST") {
                const room = await loadRoom(roomId);
                if (!room) return json(res, 404, { error: "room not found" });
                if (room.revealed) return json(res, 409, { error: "room already revealed" });
                const body = await readBody(req);
                const scored = validateAndScoreGuesses(room.participants, body.guesses);
                if (!scored.ok) return json(res, 400, { error: scored.error });
                room.guesses = scored.result;
                room.revealed = true;
                await saveRoom(room);
                return json(res, 200, { room: publicRoom(room) });
              }
            }
          }

          /* ---- playground chats ---- */
          if (seg[0] === "chats") {
            if (!seg[1] && method === "GET") {
              return json(res, 200, { chats: (await listChats()).map((c) => publicChat(c, { messages: false })) });
            }
            if (!seg[1] && method === "POST") {
              const body = await readBody(req);
              const parsed = await parseChatConfig({ ...body, modelId: body.modelId ?? "" });
              if ("error" in parsed) return json(res, 400, parsed);
              const now = Date.now();
              const chat: PlaygroundChat = {
                id: newId("chat"),
                title: parsed.config.title || "",
                modelId: parsed.config.modelId!,
                systemPrompt: parsed.config.systemPrompt ?? "",
                settings: { temperature: 1, maxTokens: 4000, reasoning: "auto", ...parsed.config.settings },
                messages: [],
                ...(parsed.config.collapseThinking ? { collapseThinking: true } : {}),
                createdAt: now,
                updatedAt: now,
              };
              await saveChat(chat);
              await appendChatLog(chat.id, {
                event: "chat.created",
                modelId: chat.modelId,
                systemPrompt: chat.systemPrompt,
                settings: chat.settings,
              });
              return json(res, 200, { chat: publicChat(chat) });
            }

            const cid = seg[1] ? safeId(seg[1]) : null;
            if (cid) {
              if (seg[2] === "message" && method === "POST") return await streamChat(req, res, cid, apiKey);

              const chat = await loadChat(cid);
              if (!chat) return json(res, 404, { error: "chat not found" });

              if (!seg[2] && method === "GET") return json(res, 200, { chat: publicChat(chat) });

              if (!seg[2] && method === "DELETE") {
                await fs.rm(chatFile(cid), { force: true });
                await fs.rm(chatLogFile(cid), { force: true });
                return json(res, 200, { ok: true });
              }

              if (seg[2] === "config" && method === "POST") {
                const parsed = await parseChatConfig(await readBody(req));
                if ("error" in parsed) return json(res, 400, parsed);
                let changed: Record<string, unknown> = {};
                const saved = await mutateChat(cid, (c) => {
                  changed = applyChatConfig(c, parsed.config);
                });
                if (!saved) return json(res, 404, { error: "chat not found" });
                if (Object.keys(changed).length) await appendChatLog(cid, { event: "config", changed });
                return json(res, 200, { chat: publicChat(saved) });
              }

              if (seg[2] === "head" && method === "POST") {
                const body = await readBody(req);
                const headId = String(body.headId ?? "");
                if (!chat.messages.some((m) => m.id === headId)) return json(res, 404, { error: "message not found" });
                let from: string | null | undefined;
                const saved = await mutateChat(cid, (c) => {
                  from = c.headId;
                  c.headId = headId;
                });
                if (!saved) return json(res, 404, { error: "chat not found" });
                if (from !== headId) await appendChatLog(cid, { event: "branch.switch", from, to: headId });
                return json(res, 200, { headId });
              }

              if (seg[2] === "comments") {
                const body = method === "DELETE" ? {} : await readBody(req);
                const text = String(body.body ?? "").trim();
                const commentId = seg[3] ? safeId(seg[3]) : null;
                let comment: ChatComment | undefined;

                if (!seg[3] && method === "POST") {
                  const field = body.field === "reasoning" ? "reasoning" : "content";
                  const quote = String(body.quote ?? "");
                  if (!text) return json(res, 400, { error: "empty comment" });
                  if (!quote.trim()) return json(res, 400, { error: "select some text to comment on" });
                  if (!chat.messages.some((m) => m.id === body.messageId) && !streamingReplies.has(String(body.messageId)))
                    return json(res, 404, { error: "message not found" });
                  const saved = await mutateChat(cid, (c) => {
                    const now = Date.now();
                    comment = {
                      id: newId("cmt"),
                      messageId: String(body.messageId),
                      field,
                      quote: quote.slice(0, 5000),
                      prefix: String(body.prefix ?? "").slice(-64),
                      suffix: String(body.suffix ?? "").slice(0, 64),
                      body: text,
                      createdAt: now,
                      updatedAt: now,
                    };
                    (c.comments ||= []).push(comment);
                  });
                  if (!saved) return json(res, 404, { error: "chat not found" });
                  await appendChatLog(cid, { event: "comment.added", comment });
                  return json(res, 200, { comments: saved.comments });
                }

                if (commentId && method === "POST") {
                  if (!text) return json(res, 400, { error: "empty comment" });
                  let before = "";
                  const saved = await mutateChat(cid, (c) => {
                    comment = c.comments?.find((x) => x.id === commentId);
                    if (!comment) return;
                    before = comment.body;
                    comment.body = text;
                    comment.updatedAt = Date.now();
                  });
                  if (!saved) return json(res, 404, { error: "chat not found" });
                  if (!comment) return json(res, 404, { error: "comment not found" });
                  await appendChatLog(cid, { event: "comment.edited", id: commentId, before, body: text });
                  return json(res, 200, { comments: saved.comments });
                }

                if (commentId && method === "DELETE") {
                  const saved = await mutateChat(cid, (c) => {
                    comment = c.comments?.find((x) => x.id === commentId);
                    if (comment) c.comments = c.comments!.filter((x) => x.id !== commentId);
                  });
                  if (!saved) return json(res, 404, { error: "chat not found" });
                  if (!comment) return json(res, 404, { error: "comment not found" });
                  // The raw log keeps the full comment, so a deleted note is never lost.
                  await appendChatLog(cid, { event: "comment.deleted", comment });
                  return json(res, 200, { comments: saved.comments ?? [] });
                }
              }

              if (seg[2] === "log" && method === "GET") {
                const text = await fs.readFile(chatLogFile(cid), "utf8").catch(() => "");
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/x-ndjson");
                return res.end(text);
              }
            }
          }

          return json(res, 404, { error: `no route for ${method} ${pathname}` });
        } catch (err) {
          console.error(err);
          if (!res.headersSent) return json(res, 500, { error: String(err) });
          res.end();
        }
      });
    },
  };
}

/* --------------------------------------------------------- chat streaming */

async function streamMessage(req: IncomingMessage, res: ServerResponse, round: Round, apiKey: string) {
  const body = await readBody(req);
  if (round.revealed) return json(res, 409, { error: "round is over — start a new one" });
  if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });

  const retry = Boolean(body.retry);
  if (!retry) {
    const content = String(body.content ?? "").trim();
    if (!content) return json(res, 400, { error: "empty message" });
    round.messages.push({ id: newId("msg"), role: "user", content, createdAt: Date.now() });
    await saveRound(round);
  }
  if (!round.messages.length) return json(res, 400, { error: "nothing to send" });

  // The serving provider names itself in upstream errors ("DeepInfra is
  // rate limited") — a hint at the model's family, so it's masked too.
  const pin = await resolvePin(round.actualModel);
  const redact = makeRedactor(round.actualModel, round.actualModelName, pin ? [pin.name, pin.tag.split("/")[0]] : []);

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const payload: Record<string, unknown> = {
    model: round.actualModel,
    provider: pin ? { order: [pin.tag], allow_fallbacks: false } : undefined,
    stream: true,
    messages: round.messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: round.settings.temperature,
    max_tokens: round.settings.maxTokens,
    usage: { include: true },
  };
  if (round.settings.reasoning === "off") payload.reasoning = { exclude: true };
  else if (round.settings.reasoning !== "auto") payload.reasoning = { effort: round.settings.reasoning };

  const started = Date.now();
  await appendLog(round.id, { event: "request", payload });
  send({ type: "start", messageId: null, requestedAt: started });

  const assistant: ChatMessage = {
    id: newId("msg"),
    role: "assistant",
    content: "",
    createdAt: started,
    meta: { requestedAt: started, chunkCount: 0 },
  };
  const toolCalls: any[] = [];
  const reasoningDetails: unknown[] = [];
  const annotations: unknown[] = [];
  let firstTokenAt: number | null = null;
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  // The group's speed target (if it has one yet): the slowest model in the
  // line-up's pace, +25% buffer. Only the visible answer is paced to it —
  // reasoning text streams at its real speed (see calibrateModel's docblock).
  const groupsForSpeed = await readJsonFile<Group[]>(GROUPS_FILE, []);
  const target = groupsForSpeed.find((g) => g.id === round.groupId)?.speedProfile ?? null;

  const contentQueue: { text: string; sent: number }[] = [];
  let contentQueuedChars = 0;
  let contentReleasedChars = 0;
  let contentReleaseAnchor: number | null = null;
  const postEvents: unknown[] = [];
  let pumpTimer: ReturnType<typeof setInterval> | null = null;

  // Releases whatever the elapsed-time budget currently allows from the head
  // of contentQueue. Called on a timer while streaming, and once more (in a
  // wait loop) after the upstream response ends, until the queue is empty.
  function drainAvailable() {
    if (!target || contentReleaseAnchor === null) return;
    const now = Date.now();
    if (now < contentReleaseAnchor) return;
    const allowed = Math.floor((now - contentReleaseAnchor) / target.targetMsPerChar) + 1;
    let toRelease = Math.min(allowed, contentQueuedChars) - contentReleasedChars;
    if (toRelease <= 0) return;
    let out = "";
    while (toRelease > 0 && contentQueue.length) {
      const item = contentQueue[0];
      const take = Math.min(item.text.length - item.sent, toRelease);
      out += item.text.slice(item.sent, item.sent + take);
      item.sent += take;
      toRelease -= take;
      contentReleasedChars += take;
      if (item.sent >= item.text.length) contentQueue.shift();
    }
    if (out) {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        assistant.meta!.firstTokenMs = firstTokenAt - started;
        send({ type: "first_token", ms: assistant.meta!.firstTokenMs, kind: "content" });
      }
      send({ type: "delta", text: out });
    }
  }

  // Feeds the pacing queue when the group has a speed target; everything
  // else (finish/usage/tool_call/annotations/mid-stream error) is held in
  // postEvents and only released once that queue has fully drained, so their
  // arrival can't betray the real completion time either.
  //
  // `text` here is always already self-id-masked (see contentGate below) —
  // this function is purely about the *wire*, not storage. assistant.content
  // (what actually gets saved) is built straight from the raw upstream
  // delta, untouched, by the caller.
  function queueContent(text: string) {
    if (!target) {
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        assistant.meta!.firstTokenMs = firstTokenAt - started;
        send({ type: "first_token", ms: assistant.meta!.firstTokenMs, kind: "content" });
      }
      send({ type: "delta", text });
      return;
    }
    if (contentReleaseAnchor === null) {
      // First-ever visible output: hold for the full TTFT target. Content
      // arriving after reasoning already showed something just gets paced
      // from now, with no extra hold.
      contentReleaseAnchor = firstTokenAt === null ? started + target.targetTtftMs : Date.now();
    }
    contentQueue.push({ text, sent: 0 });
    contentQueuedChars += text.length;
  }
  function queuePost(ev: unknown) {
    if (!target) send(ev);
    else postEvents.push(ev);
  }

  // Masks self-identifying vendor/model names out of what's actually sent
  // over the wire — the *stored* transcript (assistant.content/.reasoning)
  // is never touched; see queueContent/emitReasoning and publicMessage,
  // which does the equivalent masking when a stored round is served back.
  const contentGate = createSelfIdGate();
  const reasoningGate = createSelfIdGate();
  function emitReasoning(text: string) {
    if (!text) return;
    if (firstTokenAt === null) {
      firstTokenAt = Date.now();
      assistant.meta!.firstTokenMs = firstTokenAt - started;
      send({ type: "first_token", ms: assistant.meta!.firstTokenMs, kind: "reasoning" });
    }
    send({ type: "reasoning", text });
  }

  try {
    const upstream = await fetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5199",
        "X-Title": "blind-test",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      await appendLog(round.id, { event: "http_error", status: upstream.status, body: text });
      const msg = safeUpstreamError(text, upstream.status, redact);
      assistant.meta!.error = msg;
      send({ type: "error", status: upstream.status, message: `OpenRouter ${upstream.status}: ${msg}` });
      send({ type: "done", aborted: true });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    if (target) pumpTimer = setInterval(drainAvailable, 40);

    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          await appendLog(round.id, { event: "unparsed_chunk", raw: data.slice(0, 2000) });
          continue;
        }

        await appendLog(round.id, { event: "chunk", chunk });
        assistant.meta!.chunkCount = (assistant.meta!.chunkCount || 0) + 1;

        if (chunk.error) {
          const msg = safeUpstreamError(JSON.stringify({ error: chunk.error }), chunk.error?.code ?? 0, redact);
          assistant.meta!.error = msg;
          queuePost({ type: "error", message: msg });
          continue;
        }

        if (chunk.id && !assistant.meta!.generationId) assistant.meta!.generationId = chunk.id;
        if (chunk.provider && !assistant.meta!.provider) assistant.meta!.provider = chunk.provider;
        if (chunk.model && !assistant.meta!.modelId) assistant.meta!.modelId = chunk.model;

        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};

        const reasoningText: string | undefined = delta.reasoning ?? delta.reasoning_content;
        if (typeof reasoningText === "string" && reasoningText.length) {
          assistant.reasoning = (assistant.reasoning || "") + reasoningText; // raw, stored as-is
          emitReasoning(reasoningGate.push(reasoningText)); // masked, wire only
        }
        if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
          reasoningDetails.push(...delta.reasoning_details);
          send({ type: "reasoning_details", count: delta.reasoning_details.length });
        }

        if (typeof delta.content === "string" && delta.content.length) {
          assistant.content += delta.content; // raw, stored as-is
          const gated = contentGate.push(delta.content); // masked, wire only
          if (gated) queueContent(gated);
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = typeof tc.index === "number" ? tc.index : toolCalls.length;
            const slot = (toolCalls[i] ||= { id: tc.id, type: tc.type || "function", function: { name: "", arguments: "" } });
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.function.name += tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            queuePost({
              type: "tool_call",
              index: i,
              id: slot.id,
              name: slot.function.name,
              argumentsDelta: tc.function?.arguments || "",
            });
          }
        }

        if (Array.isArray(delta.annotations) && delta.annotations.length) {
          annotations.push(...delta.annotations);
          queuePost({ type: "annotations", count: delta.annotations.length });
        }

        if (choice?.finish_reason) {
          assistant.meta!.finishReason = choice.finish_reason;
          assistant.meta!.nativeFinishReason = choice.native_finish_reason ?? null;
          queuePost({ type: "finish", finishReason: choice.finish_reason });
        }

        if (chunk.usage) {
          const u = { ...chunk.usage };
          assistant.meta!.cost = typeof u.cost === "number" ? u.cost : null;
          delete u.cost;
          delete u.cost_details;
          assistant.meta!.usage = u;
          assistant.meta!.reasoningTokens = u?.completion_tokens_details?.reasoning_tokens ?? null;
          queuePost({ type: "usage", usage: sanitizeUsage(u, false) });
        }
      }
    }
  } catch (err) {
    const msg = redact(String(err)).slice(0, 800);
    await appendLog(round.id, { event: "exception", error: String(err) });
    assistant.meta!.error = msg;
    queuePost({ type: "error", message: msg });
  }

  // Nothing more is coming — release whatever either gate was still holding
  // back as a possible partial term match.
  emitReasoning(reasoningGate.flush());
  const finalContent = contentGate.flush();
  if (finalContent) queueContent(finalContent);

  // Let the pacing queue finish draining (if it hasn't already) before telling
  // the client generation is done — otherwise "finish"/"usage"/"done" would
  // arrive at the real completion time while text is still trickling out.
  if (target) {
    drainAvailable();
    while (!aborted && contentReleasedChars < contentQueuedChars) {
      await sleep(40);
      drainAvailable();
    }
  }
  if (pumpTimer) clearInterval(pumpTimer);
  for (const ev of postEvents) send(ev);

  assistant.meta!.totalMs = Date.now() - started;
  if (toolCalls.length) assistant.toolCalls = toolCalls.filter(Boolean);
  if (reasoningDetails.length) assistant.reasoningDetails = reasoningDetails;
  if (annotations.length) assistant.annotations = annotations;

  if (assistant.content || assistant.reasoning || assistant.toolCalls || assistant.meta!.error) {
    round.messages.push(assistant);
    await saveRound(round);
  }
  await appendLog(round.id, {
    event: "assistant_message",
    id: assistant.id,
    chars: assistant.content.length,
    reasoningChars: assistant.reasoning?.length || 0,
    meta: assistant.meta,
  });

  send({ type: "done", message: publicMessage(assistant, round.revealed), round: publicRound(round, { messages: false }) });
  res.end();

  // Generation stats (cost, native token counts, provider throughput) settle a
  // beat after the stream ends, so they are collected in the background and
  // merged into the stored round. They only reach the browser after the reveal.
  if (assistant.meta!.generationId) void collectGeneration(round.id, assistant.id, assistant.meta!.generationId!, apiKey);
}

// Generation stats (cost, native token counts, provider throughput) settle
// a while after the stream ends — OpenRouter 404s the record for ~10s or more —
// so they're polled for up to ~40s before giving up.
async function fetchGeneration(generationId: string, apiKey: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await sleep(Math.min(1000 + attempt * 1000, 5000));
      const g = await fetch(`${OPENROUTER}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!g.ok) continue;
      const gd = (await g.json()) as any;
      return gd?.data ?? gd;
    } catch {
      /* best effort */
    }
  }
  return null;
}

function mergeGeneration(msg: ChatMessage, data: Record<string, unknown>) {
  msg.meta = { ...(msg.meta || {}) };
  msg.meta.generation = data;
  if (typeof data.total_cost === "number") msg.meta.cost = data.total_cost;
}

async function collectGeneration(roundId: string, messageId: string, generationId: string, apiKey: string) {
  const data = await fetchGeneration(generationId, apiKey);
  if (!data) return;
  await appendLog(roundId, { event: "generation", generation: data });
  // Re-read: the round may have moved on while we were waiting.
  const fresh = await loadRound(roundId);
  const msg = fresh?.messages.find((m) => m.id === messageId);
  if (!fresh || !msg) return;
  mergeGeneration(msg, data);
  await saveRound(fresh);
}

/* ------------------------------------------------- playground streaming */

// Same wire protocol as a round's stream (start / first_token / delta /
// reasoning / finish / usage / error / done), minus everything that exists to
// keep a round blind: no self-id mask, no speed throttle, nothing sealed.
async function streamChat(req: IncomingMessage, res: ServerResponse, chatId: string, apiKey: string) {
  const body = await readBody(req);
  if (!apiKey) return json(res, 400, { error: "No OPENROUTER_API_KEY on the server." });

  const parsed = await parseChatConfig(body);
  if ("error" in parsed) return json(res, 400, parsed);
  // Three ways to get a reply, none of which ever deletes anything:
  //  - content: a new user message, after the current branch's last message —
  //    or, with an explicit parentId, as a sibling of the message being edited;
  //  - regenerate: a fresh reply to the user message the given reply answered,
  //    added next to it as a sibling branch;
  //  - retry: answer the current branch's last message again (a new sibling if
  //    it's a reply, a first reply if it's your message).
  const retry = Boolean(body.retry);
  const regenerate = body.regenerate ? String(body.regenerate) : null;
  const content = String(body.content ?? "").trim();
  if (!retry && !regenerate && !content) return json(res, 400, { error: "empty message" });

  let changed: Record<string, unknown> = {};
  let replyTo: string | null = null;
  let newUserId: string | null = null;
  let branch: Record<string, unknown> | null = null;
  let problem: string | null = null;
  const chat = await mutateChat(chatId, (c) => {
    const byId = new Map(c.messages.map((m) => [m.id, m]));
    const head = c.headId ? byId.get(c.headId) : undefined;
    if (regenerate || retry) {
      const target = regenerate ? byId.get(regenerate) : head;
      if (!target) return void (problem = "nothing to regenerate");
      replyTo = target.role === "user" ? target.id : (target.parentId ?? null);
      if (!replyTo) return void (problem = "that reply has no message to answer");
      if (target.role === "assistant") branch = { kind: "regenerate", of: target.id, replyTo };
    } else {
      const hasParent = Object.prototype.hasOwnProperty.call(body, "parentId");
      const parentId: string | null = hasParent ? (body.parentId === null ? null : String(body.parentId)) : (c.headId ?? null);
      if (parentId && !byId.has(parentId)) return void (problem = "parent message not found");
      const msg: ChatMessage = { id: newId("msg"), parentId, role: "user", content, createdAt: Date.now() };
      if (hasParent && parentId !== (c.headId ?? null)) {
        branch = { kind: "edit", parentId, from: c.headId ?? null, newMessage: msg.id };
      }
      c.messages.push(msg);
      replyTo = newUserId = msg.id;
      if (!c.title) c.title = content.replace(/\s+/g, " ").slice(0, 60);
    }
    changed = applyChatConfig(c, parsed.config);
    c.headId = replyTo;
  });
  if (!chat) return json(res, 404, { error: "chat not found" });
  if (problem) return json(res, 400, { error: problem });
  if (Object.keys(changed).length) await appendChatLog(chat.id, { event: "config", changed });
  if (branch) await appendChatLog(chat.id, { event: "branch", ...(branch as object) });

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const messages: { role: string; content: string }[] = [];
  if (chat.systemPrompt.trim()) messages.push({ role: "system", content: chat.systemPrompt });
  // Only the branch being answered — and an assistant turn that only errored
  // has nothing to say, so leave it out.
  for (const m of chatPath(chat, replyTo))
    if (m.role === "user" || m.content) messages.push({ role: m.role, content: m.content });

  const payload: Record<string, unknown> = {
    model: chat.modelId,
    provider: await providerRouting(chat.modelId),
    stream: true,
    messages,
    temperature: chat.settings.temperature,
    max_tokens: chat.settings.maxTokens,
    usage: { include: true },
  };
  if (chat.settings.reasoning === "off") payload.reasoning = { exclude: true };
  else if (chat.settings.reasoning !== "auto") payload.reasoning = { effort: chat.settings.reasoning };

  const started = Date.now();
  await appendChatLog(chat.id, { event: "request", payload });

  const assistant: ChatMessage = {
    id: newId("msg"),
    parentId: replyTo,
    role: "assistant",
    content: "",
    createdAt: started,
    meta: { requestedAt: started, chunkCount: 0, requestedModel: chat.modelId, systemPrompt: chat.systemPrompt },
  };
  // The real ids go out up front, so the reply can be commented on while it streams.
  send({ type: "start", requestedAt: started, userMessageId: newUserId, assistantMessageId: assistant.id });
  streamingReplies.add(assistant.id);
  const meta = assistant.meta!;
  const toolCalls: any[] = [];
  const reasoningDetails: unknown[] = [];
  const annotations: unknown[] = [];
  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  function firstToken(kind: "content" | "reasoning") {
    if (meta.firstTokenMs != null) return;
    meta.firstTokenMs = Date.now() - started;
    send({ type: "first_token", ms: meta.firstTokenMs, kind });
  }

  try {
    const upstream = await fetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5199",
        "X-Title": "blind-test (playground)",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      await appendChatLog(chat.id, { event: "http_error", status: upstream.status, body: text });
      let msg = text.slice(0, 800);
      try {
        msg = JSON.parse(text)?.error?.message ?? msg;
      } catch {
        /* keep raw */
      }
      meta.error = `OpenRouter ${upstream.status}: ${msg}`;
      send({ type: "error", status: upstream.status, message: meta.error });
    } else {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            await appendChatLog(chat.id, { event: "unparsed_chunk", raw: data.slice(0, 2000) });
            continue;
          }
          await appendChatLog(chat.id, { event: "chunk", chunk });
          meta.chunkCount = (meta.chunkCount || 0) + 1;

          if (chunk.error) {
            meta.error = String(chunk.error?.message ?? JSON.stringify(chunk.error)).slice(0, 800);
            send({ type: "error", message: meta.error });
            continue;
          }
          if (chunk.id && !meta.generationId) meta.generationId = chunk.id;
          if (chunk.provider && !meta.provider) meta.provider = chunk.provider;
          if (chunk.model && !meta.modelId) meta.modelId = chunk.model;

          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};

          const reasoningText: string | undefined = delta.reasoning ?? delta.reasoning_content;
          if (typeof reasoningText === "string" && reasoningText.length) {
            firstToken("reasoning");
            assistant.reasoning = (assistant.reasoning || "") + reasoningText;
            send({ type: "reasoning", text: reasoningText });
          }
          if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
            reasoningDetails.push(...delta.reasoning_details);
            send({ type: "reasoning_details", count: delta.reasoning_details.length });
          }
          if (typeof delta.content === "string" && delta.content.length) {
            firstToken("content");
            assistant.content += delta.content;
            send({ type: "delta", text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = typeof tc.index === "number" ? tc.index : toolCalls.length;
              const slot = (toolCalls[i] ||= { id: tc.id, type: tc.type || "function", function: { name: "", arguments: "" } });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name += tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
              send({ type: "tool_call", index: i, id: slot.id, name: slot.function.name, argumentsDelta: tc.function?.arguments || "" });
            }
          }
          if (Array.isArray(delta.annotations) && delta.annotations.length) {
            annotations.push(...delta.annotations);
            send({ type: "annotations", count: delta.annotations.length });
          }
          if (choice?.finish_reason) {
            meta.finishReason = choice.finish_reason;
            meta.nativeFinishReason = choice.native_finish_reason ?? null;
            send({ type: "finish", finishReason: choice.finish_reason, nativeFinishReason: meta.nativeFinishReason });
          }
          if (chunk.usage) {
            const u = { ...chunk.usage };
            meta.cost = typeof u.cost === "number" ? u.cost : null;
            meta.usage = u;
            meta.reasoningTokens = u?.completion_tokens_details?.reasoning_tokens ?? null;
            send({ type: "usage", usage: u });
          }
        }
      }
    }
  } catch (err) {
    await appendChatLog(chat.id, { event: "exception", error: String(err) });
    meta.error = String(err).slice(0, 800);
    send({ type: "error", message: meta.error });
  }

  meta.totalMs = Date.now() - started;
  if (toolCalls.length) assistant.toolCalls = toolCalls.filter(Boolean);
  if (reasoningDetails.length) assistant.reasoningDetails = reasoningDetails;
  if (annotations.length) assistant.annotations = annotations;

  let saved: PlaygroundChat | null = chat;
  if (assistant.content || assistant.reasoning || assistant.toolCalls || meta.error) {
    saved =
      (await mutateChat(chat.id, (c) => {
        c.messages.push(assistant);
        // Follow the new reply, unless you've since moved to another branch.
        if (c.headId === replyTo) c.headId = assistant.id;
      })) ?? chat;
  }
  streamingReplies.delete(assistant.id);
  await appendChatLog(chat.id, {
    event: "assistant_message",
    id: assistant.id,
    aborted,
    chars: assistant.content.length,
    reasoningChars: assistant.reasoning?.length || 0,
    meta,
  });

  send({ type: "done", message: assistant, chat: publicChat(saved, { messages: false }) });
  res.end();

  if (meta.generationId) void collectChatGeneration(chat.id, assistant.id, meta.generationId, apiKey);
}

async function collectChatGeneration(chatId: string, messageId: string, generationId: string, apiKey: string) {
  const data = await fetchGeneration(generationId, apiKey);
  // The chat may have been deleted while we waited — don't resurrect its log.
  if (!data || !(await loadChat(chatId))) return;
  await appendChatLog(chatId, { event: "generation", generation: data });
  await mutateChat(chatId, (c) => {
    const msg = c.messages.find((m) => m.id === messageId);
    if (msg) mergeGeneration(msg, data);
  });
}

/* ---------------------------------------------------------------- config */

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, "");
  const apiKey = process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || "";
  const keySource = process.env.OPENROUTER_API_KEY ? "environment" : env.OPENROUTER_API_KEY ? ".env file" : "missing";
  if (!apiKey) {
    console.warn("\n  [blind-test] No OPENROUTER_API_KEY found. Export it or put it in .env, then restart.\n");
  }
  // Only used by the compare tab, to embed responses for distance-ranking —
  // the blind-test rounds never touch it.
  const openaiApiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || "";
  if (!openaiApiKey) {
    console.warn("\n  [blind-test] No OPENAI_API_KEY found — the compare tab's distance ranking needs it.\n");
  }
  return {
    plugins: [react(), blindTestApi(apiKey, keySource, openaiApiKey)],
    server: { port: 5199, strictPort: false },
  };
});
