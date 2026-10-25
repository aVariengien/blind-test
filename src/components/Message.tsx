import Markdownish, { lines } from "./Markdownish";
import type { ChatMessage } from "../types";

const ms = (n?: number) => (typeof n === "number" ? `${(n / 1000).toFixed(n < 10000 ? 2 : 1)}s` : null);

export default function Message({
  msg,
  revealed,
  details,
  thinking,
}: {
  msg: ChatMessage;
  revealed: boolean;
  /** Show the per-message instrumentation. Off by default for a clean read. */
  details: boolean;
  /**
   * How to show reasoning. "inline" streams it above the answer like the answer
   * itself, in grey; "collapsed" folds it away until clicked open, then shows
   * the same. Unset keeps the compact foldout rounds use.
   */
  thinking?: "inline" | "collapsed";
}) {
  const meta = msg.meta || {};
  const usage = meta.usage || {};
  const who = msg.role === "user" ? "you" : revealed && meta.modelId ? meta.modelId : "the model";

  const tags: Array<{ label: string; hot?: boolean }> = [];
  if (msg.role === "assistant") {
    if (meta.firstTokenMs != null) tags.push({ label: `ttft ${ms(meta.firstTokenMs)}` });
    if (meta.totalMs != null) tags.push({ label: `total ${ms(meta.totalMs)}` });
    if (usage.prompt_tokens != null) tags.push({ label: `in ${usage.prompt_tokens}` });
    if (usage.completion_tokens != null) tags.push({ label: `out ${usage.completion_tokens}` });
    if (meta.reasoningTokens) tags.push({ label: `reasoning ${meta.reasoningTokens}`, hot: true });
    if (meta.chunkCount) tags.push({ label: `${meta.chunkCount} chunks` });
    if (meta.finishReason) tags.push({ label: `finish: ${meta.finishReason}` });
    if (revealed && meta.nativeFinishReason && meta.nativeFinishReason !== meta.finishReason)
      tags.push({ label: `native: ${meta.nativeFinishReason}` });
    if (revealed && meta.provider) tags.push({ label: `via ${meta.provider}`, hot: true });
    if (revealed && meta.cost != null) tags.push({ label: `$${meta.cost.toFixed(6)}` });
    if (revealed && meta.generationId) tags.push({ label: meta.generationId });
  }

  return (
    <div className={`msg ${msg.role}`}>
      <div className="who">{who}</div>

      {msg.reasoning && thinking ? (
        <Thinking msg={msg} collapsed={thinking === "collapsed"} />
      ) : msg.reasoning ? (
        <details className="foldout" open={msg.pending && !msg.content}>
          <summary>
            thinking · {msg.reasoning.length.toLocaleString()} chars
            {msg.pending && !msg.content ? " · streaming" : ""}
          </summary>
          <div className="body" data-msg-id={msg.id} data-field="reasoning">
            {msg.reasoning}
          </div>
        </details>
      ) : null}

      {msg.toolCalls?.length ? (
        <details className="foldout" open>
          <summary>tool calls · {msg.toolCalls.length}</summary>
          <div className="body code">
            {msg.toolCalls.map((tc, i) => (
              <div key={i}>
                {i > 0 ? "\n" : ""}
                {tc.function?.name || "(unnamed)"}({tc.function?.arguments || ""}){tc.id ? `  // ${tc.id}` : ""}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="bubble" data-msg-id={msg.id} data-field="content">
        <Markdownish text={msg.content} />
        {msg.pending ? <i className="caret" /> : null}
      </div>

      {details && (msg.reasoningDetails?.length || (revealed && msg.meta?.generation)) ? (
        <details className="foldout">
          <summary>raw metadata</summary>
          <div className="body code">
            {JSON.stringify(
              { reasoningDetails: msg.reasoningDetails, annotations: msg.annotations, generation: msg.meta?.generation },
              null,
              2,
            )}
          </div>
        </details>
      ) : null}

      {meta.error ? <div className="err">{meta.error}</div> : null}

      {details && tags.length ? (
        <div className="metaline">
          {tags.map((t, i) => (
            <span key={i} className={t.hot ? "hot" : undefined}>
              {t.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Thinking({ msg, collapsed }: { msg: ChatMessage; collapsed: boolean }) {
  const live = msg.pending && !msg.content;
  const body = (
    <div className="thinking-body" data-msg-id={msg.id} data-field="reasoning">
      {lines(msg.reasoning!)}
      {live ? <i className="caret" /> : null}
    </div>
  );
  if (!collapsed) {
    return (
      <div className="thinking">
        <div className="thinking-label">thinking{live ? " · streaming" : ""}</div>
        {body}
      </div>
    );
  }
  // Uncontrolled: once you open one it stays open while the reply keeps streaming.
  return (
    <details className="thinking folded">
      <summary className="thinking-label">
        thinking · {msg.reasoning!.length.toLocaleString()} chars{live ? " · streaming" : ""}
      </summary>
      {body}
    </details>
  );
}
