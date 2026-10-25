# blind test

This project grew organically. It started as a blind test (talk to a model you can't see,
then guess who it was) and grew into a set of UIs that give you more control over chats
and over how you work with LLMs: a branching [playground](#playground) with comments, a
[compare](#compare) view across models, and a blind multi-model [room](#room). The app
opens on the playground.

The original blind test is still there on the **chat** tab. A round draws one model at
random from a group you define, and you chat with it through OpenRouter. When you're ready
you make one guess from that group's line-up, the answer is revealed, and the result goes
into your stats.

```
make
```

That installs deps if needed, starts the app on <http://localhost:5199>, and opens it in
your browser.

## Setup

The server reads your keys from the environment:

```bash
export OPENROUTER_API_KEY=sk-or-...
export OPENAI_API_KEY=sk-...     # optional — only needed for the compare tab
```

Or drop them in a `.env` file next to the `Makefile`:

```
OPENROUTER_API_KEY=sk-or-...
OPENAI_API_KEY=sk-...
```

Neither key ever reaches the browser — every OpenRouter and OpenAI call goes out from the dev
server. `OPENROUTER_API_KEY` is required for everything; `OPENAI_API_KEY` is only used to
embed responses on the [compare](#compare) tab and the app works fine without it (compare
just can't rank by distance).

## Groups

A group is a line-up of OpenRouter model ids: the pool a round draws from, and the list you
pick your guess out of. Every id is checked against OpenRouter's live catalogue before a
group can be saved, with type-ahead over all ~400 models and "did you mean" suggestions on a
miss. Routing variants (`:free`, `:nitro`, `:floor`, …) are accepted too.

There's a **Seed a starter group** button on first run if you'd rather not type six ids.

Saving a group (or changing its line-up) kicks off a one-time **speed test**: each model
gets a short real completion so the server can clock its time-to-first-token and generation
pace. The slowest model's numbers, +25% buffer, become that group's throttle — see
[Staying blind](#staying-blind). It runs in the background (save returns immediately) and
usually finishes in a few seconds, longer for a slow reasoning model; the group card shows
its status and a **recalibrate** link once it's done.

## Providers

Every model is pinned to one OpenRouter provider, app-wide (rounds, compare, rooms, the speed
test and the playground), and sent with `allow_fallbacks: false`. If that provider is down,
the request fails instead of quietly switching to another host. Until you choose one, a model
uses the **default**: the model maker's own API when OpenRouter carries it (OpenAI for
`openai/*`, Google for `google/*`, …). Otherwise it's the most reliable host (≥98% uptime over
the last day), with the least quantization winning ties.

Change it from the provider dropdowns on a group card or next to the model in the
playground. Pins are stored in `data/providers.json`. A model left on the default moves to a
new default if its provider stops serving it; a provider you picked yourself stays pinned and
gets flagged. A different host means a different speed, so changing a pin re-runs the speed
test of every group that uses that model.

## Playing

- **New round** draws a model uniformly at random from the selected group. Nothing about
  which one reaches the browser.
- Chat as long as you like. `⌘/Ctrl+Enter` sends.
- **Guess** opens the picker. One guess per round — it locks the round and reveals the answer.
- Temperature, max tokens and reasoning effort are per-round and live in the composer bar.
- No system prompt is sent, so "who are you?" usually gets an answer — the server just masks
  the name out of it. See [Staying blind](#staying-blind).

## Reading the conversation

The default view is just the chat: question, answer, and a collapsed thinking block if the
model produced one. Scrolling is yours — the view follows the stream only while you're
already at the bottom, so you can read back through an earlier answer while the model is
still writing and nothing yanks you around. A **latest ↓** pill appears when you've scrolled
away; click it to re-attach.

**details** in the top bar turns the instrumentation back on: the event-log sidebar and the
per-message metadata tags. It's off by default and remembered between sessions.

## What gets logged

Everything, whether or not **details** is on. Each round writes `data/logs/<round-id>.jsonl` containing the exact request
payload, every raw SSE chunk from OpenRouter, upstream errors, the post-hoc generation
record (cost, native token counts, provider throughput) and the guess.

**Thinking blocks** show either way: reasoning deltas stream into a collapsible block above
the answer, with a character count. With **details** on you also get, in the app:

- **Event log sidebar** — every stream event as it arrives: `start`, `first_token`, `finish`,
  `usage`, `tool_call`, `error`, `done`. Flip on **verbose** to include every content and
  reasoning delta.
- **Tool calls** — if a model emits `tool_calls` unprompted, name and streamed arguments are
  captured and shown. No tool definitions are ever sent.
- **Per-message metadata** — time to first token, total time, prompt/completion tokens,
  reasoning tokens, chunk count, finish reason.
- **Raw log viewer** — the whole `.jsonl` for the round, unlocked after you guess.

## Staying blind

Everything *around* the conversation is sealed until you guess, because it would otherwise
hand you the answer for free:

- the true model id, provider name, generation id and cost
- `native_finish_reason` (`STOP` vs `end_turn` vs `stop` is a pure vendor fingerprint)
- vendor-shaped `usage` fields — pre-reveal you get neutral counters only
- `reasoning_details` formats and signatures (`google-gemini-v1`, …)
- upstream error bodies, which name the serving provider and quote the model id. Only a
  scrubbed summary reaches the browser; the full body is in the log.

The server refuses to serve a round's raw log until the guess is in.

The conversation itself is filtered on the way out, in two ways — but what's actually stored
in `data/rounds/<id>.json` is always the model's real, untouched output. Nothing about the
conversation is ever rewritten on disk:

- **Self-identification is masked.** "I'm ChatGPT, built by OpenAI" streams in as "I'm █,
  built by █." Every match becomes the same single █, regardless of how long the actual name
  was — a longer mask for "Google DeepMind" than for "Grok" would itself be a tell. The filter
  runs on a known list of AI vendor/model-family names (OpenAI,
  Anthropic, Claude, Gemini, Llama, Mistral, DeepSeek, Grok, …), live, character by character,
  so a name split across two stream chunks is still caught before it ever reaches the browser.
  It applies at two points — the live SSE stream, and again whenever a stored round is served
  back to the browser (reload, round history) — never to the file itself. It only catches a
  model saying who *it* is; if it wrongly claims to be a different, unrelated model, or the
  topic is genuinely about one of these companies, that also gets masked as a side effect.
  It's a fixed list, not perfect, and only covers well-known names.
- **Speed is normalized per group.** A round no longer runs at the drawn model's real pace —
  every round in a group is throttled to that group's slowest model's time-to-first-token and
  characters/sec (+25% buffer), computed by the one-time speed test described under
  [Groups](#groups). So a fast model can't be picked out just by how quickly it starts
  answering or how fast it types. Reasoning text is the one exception — it streams at its
  real speed, unthrottled. (Unlike masking, pacing is only ever a live-stream thing — there's
  nothing to redo when a finished round is served back.)

Both apply for the life of the round, not just pre-reveal — unlike the sealed fields above,
guessing doesn't turn them off. The raw log is the one place the true, real-time, unmasked
text always was and still is (each upstream `chunk` event is logged before the mask ever
runs), same as everything else the raw log keeps.

## Stats

- Overall accuracy, correct count, current streak, average questions per round
- Per model: how often it appeared, how often you spotted it (**recall**), and how often you
  were right when you called it (**precision**)
- A confusion matrix — who it was, versus who you said it was
- Every round, clickable back to its transcript

## Compare

A different tool from rounds, on its own tab — nothing is hidden here. Type prompts into the
textarea, one per line (or hit **Seed prompts** for a curated starter set — reasoning traps
like the 9.11-vs-9.9 and bat-and-ball questions, a moral dilemma, self-referential and
creative-style prompts, deliberately picked to split model families and capability levels
apart rather than to trip any one of them up), pick a group, and **Run**. Every model in the
group answers every prompt — that's `models × prompts` OpenRouter calls, shown as a count
before you run it.

Each response is embedded with OpenAI's `text-embedding-3-small` and scored by its mean
cosine distance to the *other* responses to that same prompt: low means it reads like the
group's consensus, high flags it as the outlier. Responses for a prompt are shown sorted by
that score, real model names attached, with the outliers visually called out — this is a
diagnostic tool, not a blind round, so nothing is withheld. Without `OPENAI_API_KEY` it still
runs, just without the distance ranking.

A run is saved as it goes (`data/compare/<id>.json`) so you can navigate away and it keeps
going, and past runs are listed for revisiting or deleting.

## Room

A blind group chat: every model in a group joins as a participant — `@model1`, `@model2`, …,
in an order shuffled fresh each time you spin up a room — and which real model is behind
which handle is hidden exactly like a round's actual model, until you guess. The room's rules
message — shown at the top for transparency — and the personalized system prompt each model
actually gets both explain the same protocol:

- `@models` addresses everyone; `@handle` addresses one or more specific participants.
- **A model gets no reply unless it's mentioned.** Sending a message with nobody @mentioned
  just adds it to the transcript.
- **A model mentioning another participant's handle in its own reply is what brings that
  participant in** — including one model mentioning another, so they can hand off to each
  other without you in the loop. This cascades (capped at 12 replies per message you send, so
  mutual mentions can't run away) until nobody new gets mentioned.
- The personalized prompt also tells each model this is a blind test and asks it not to
  state or hint at its own identity — belt-and-suspenders with the same self-id mask rounds
  use, which still runs on every model message here too, permanently, same as in rounds.

Each model sees the transcript with everyone else's turns labeled by handle and its own prior
turns as its own — so it can tell who said what — plus its personalized rules message as a
system prompt. Replies happen one at a time, in order, saved as they land
(`data/rooms/<id>.json`), so leaving and coming back picks up mid-cascade.

**Guess who's who** opens a picker with one slot per handle, each filled from the group's
line-up (with real names, exactly like a round's guess picker) — fill in every handle and
submit to reveal the whole room at once: every participant's real model, and which of your
guesses landed. Guessing (like sending a message) is blocked once a room is already revealed;
start a new room to play again.

## Playground

A plain chat on its own tab, with nothing hidden. Pick any model from OpenRouter's catalogue
(type-ahead, and focusing the empty box lists every model in your groups), optionally set a
system prompt, and talk. Temperature, max tokens and reasoning effort sit in the composer
bar, same as a round. Nothing is masked or throttled, and every message shows its real model.

You can change the model, the system prompt or the settings mid-chat. The change applies
from the next turn, and each reply records the model and system prompt it was actually sent
with, so the thread shows a marker wherever either one changed. **Stop** cuts a stream short.

**Scrolling** is entirely yours. The view jumps to the bottom when you open a chat or send a
message, and never follows the tokens as they arrive. **latest ↓** takes you down when you want.

**Thinking.** A reasoning model's thinking streams in right above its answer, in the same
type as the answer, just greyed back, so you can read it as it's written and comment on it like
any other text. **fold thinking** in the chat's top bar collapses it instead, per chat, saved
with the chat. Each folded block shows its length, and clicking it opens it back up as usual.

**Branches.** A chat is a tree, and nothing in it is ever deleted. Hover one of your
messages and hit **edit** to send a changed version as a new branch from that point.
Hover a reply and hit **regenerate** to get another answer to the same message. Either way
the original stays, and a **‹ 1/2 ›** switcher under that turn cycles through the versions.
Switching to a version picks up its most recent continuation. The **tree** button opens an
outline of the whole conversation, with every fork, the branch you're on highlighted, and a
count of your notes per turn. Click any turn to jump there. Chats from before branching open
as a single branch.

**Comments.** Select any text in a message (your own, a reply, or its thinking)
and a **+ comment** button appears in the margin. That works while a reply is still streaming,
too: everything but the line being written right now holds still under your selection. Notes sit beside the text they're attached
to, Google Docs style. Click a highlight to bring its note forward, and hover a note to edit
or delete it. A note is anchored by the quoted text plus a little context either side, so it
finds its place again after a reload. Notes on another branch stay with that branch and show
up when you switch to it. A note on a reply dropped by the old retry (before branching
existed) is kept and shown dashed, as no longer in the chat.

**Copy as markdown** (top bar) copies the branch on screen: title, model, system prompt (and
any mid-chat change to it), each turn with its thinking and answer, and your comments listed
after the message they're on. Both markdown and formatted HTML go to the clipboard, so a text
editor gets the markdown and Google Docs pastes headings, lists and grey thinking already formatted.

Every chat is saved locally and listed on the left, so you can reopen, rename (double-click its
name, or the ✎ on hover) or delete it:

- `data/chats/<id>.json`: model, system prompt, settings, every message on every branch (each
  pointing at its parent), the branch you're on, and your comments
- `data/chats/logs/<id>.jsonl`: the raw log, holding every exact request payload, each raw SSE
  chunk, config changes, every branch created (edit or regenerate) and every switch between branches,
  every comment added, edited or deleted (with the full text), errors and the post-hoc generation record (cost, provider). The
  **raw log** button shows it.

## Data

Plain JSON on disk, all under `data/` (gitignored):

```
data/groups.json          your model groups
data/rounds/<id>.json     one file per round: transcript, answer, guess, verdict
data/logs/<id>.jsonl      raw stream log per round
data/compare/<id>.json    one file per compare run: prompts, responses, distances
data/rooms/<id>.json      one file per room: participants, rules, transcript, guesses
data/chats/<id>.json      one file per playground chat: model, system prompt, transcript
data/chats/logs/<id>.jsonl  raw stream log per playground chat
data/catalog.json         cached OpenRouter model catalogue (6h TTL)
```

`make reset-stats` clears rounds and logs, keeping your groups (compare runs, rooms and playground chats aren't
touched — delete those individually from their own tabs).

## Targets

```
make            start the app and open it
make build      type-check and build to dist/
make reset-stats  delete all rounds and logs
make help       list targets
```
