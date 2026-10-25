import { marked } from "marked";
import type { ChatComment, ChatMessage } from "./types";

// Turns the branch on screen into a document you can paste elsewhere: the
// system prompt, every turn, thinking, answers, and your notes after each
// message. Built twice from the same pieces — markdown for text editors, and
// HTML for rich editors like Google Docs, which ignore markdown on paste.

const THINKING_COLOR = "#8a857c";

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

// Single newlines matter in a model's output (the app shows them as-is), so keep them as breaks.
const render = (md: string) => marked.parse(md, { gfm: true, breaks: true, async: false }) as string;

/** Notes in reading order: thinking before answer, then by where the quote sits. */
function ordered(msg: ChatMessage, comments: ChatComment[]): ChatComment[] {
  const pos = (c: ChatComment) => {
    const at = (c.field === "reasoning" ? msg.reasoning || "" : msg.content).indexOf(c.quote);
    return at === -1 ? Infinity : at;
  };
  return comments
    .filter((c) => c.messageId === msg.id)
    .sort((a, b) => (a.field === b.field ? pos(a) - pos(b) || a.createdAt - b.createdAt : a.field === "reasoning" ? -1 : 1));
}

function commentsBlock(msg: ChatMessage, notes: ChatComment[]): string {
  const items = notes.map((c) => {
    const where = msg.reasoning && c.field === "reasoning" ? " (in thinking)" : "";
    const body = c.body.trim().replace(/\n/g, "\n  ");
    return `- On “${c.quote.replace(/\s+/g, " ").trim()}”${where}:\n  ${body}`;
  });
  return `**Comments**\n\n${items.join("\n")}`;
}

export function conversationToMarkdown({
  title,
  modelId,
  systemPrompt,
  path,
  comments,
}: {
  title: string;
  modelId: string;
  systemPrompt: string;
  path: ChatMessage[];
  comments: ChatComment[];
}): { markdown: string; html: string } {
  const md: string[] = [];
  const html: string[] = [];
  const add = (text: string, wrap?: (inner: string) => string) => {
    md.push(text);
    html.push(wrap ? wrap(render(text)) : render(text));
  };

  const firstReply = path.find((m) => m.role === "assistant" && m.meta?.systemPrompt !== undefined);
  let prompt = firstReply?.meta?.systemPrompt ?? systemPrompt;
  const models = [...new Set(path.map((m) => m.meta?.requestedModel).filter(Boolean))];
  if (!models.length && modelId) models.push(modelId);

  add(`# ${title.trim() || "Conversation"}`);
  add(
    [
      models.length ? `**Model${models.length > 1 ? "s" : ""}:** ${models.map((m) => `\`${m}\``).join(", ")}` : "",
      `**Exported:** ${new Date().toLocaleString()}`,
    ]
      .filter(Boolean)
      .join("  \n"),
  );
  add(`## System prompt\n\n${prompt.trim() ? quote(prompt.trim()) : "_none_"}`);

  for (const m of path) {
    if (m.role === "assistant" && m.meta?.systemPrompt !== undefined && m.meta.systemPrompt !== prompt) {
      prompt = m.meta.systemPrompt;
      add(`## System prompt changed\n\n${prompt.trim() ? quote(prompt.trim()) : "_removed_"}`);
    }
    md.push("---");
    html.push("<hr>");

    if (m.role === "user") {
      add(`## You\n\n${m.content}`);
    } else {
      add(`## ${m.meta?.requestedModel || m.meta?.modelId || modelId || "Assistant"}`);
      if (m.reasoning) {
        md.push(`### Thinking\n\n${quote(m.reasoning)}`);
        html.push(`<h3>Thinking</h3><div style="color:${THINKING_COLOR}">${render(m.reasoning)}</div>`);
        if (m.content) add(`### Answer\n\n${m.content}`);
      } else if (m.content) {
        add(m.content);
      }
      if (m.meta?.error) add(`> ⚠️ ${m.meta.error}`);
    }

    const notes = ordered(m, comments);
    if (notes.length) add(commentsBlock(m, notes));
  }

  return {
    markdown: `${md.join("\n\n")}\n`,
    html: `<meta charset="utf-8"><div>${html.join("\n")}</div>`,
  };
}

/** Put both flavours on the clipboard; whatever you paste into picks the one it understands. */
export async function copyRich(markdown: string, html: string) {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([markdown], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      /* fall back to plain text */
    }
  }
  await navigator.clipboard.writeText(markdown);
}
