import type { JSX } from "react";

/**
 * A deliberately small markdown subset: fenced code, headings, bold, italic and
 * inline code. Lists, tables and the rest stay literal, because how a model
 * lays out an answer is exactly the sort of tell you are here to notice.
 */
export default function Markdownish({ text }: { text: string }) {
  const parts: Array<{ code: boolean; lang?: string; text: string }> = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, lang: m[1] || undefined, text: m[2].replace(/\n$/, "") });
    last = fence.lastIndex;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });

  return (
    <>
      {parts.map((p, i) => {
        if (p.code) {
          return (
            <pre key={i} data-lang={p.lang}>
              {p.text}
            </pre>
          );
        }
        // The <pre> block brings its own margin, so drop the blank lines that
        // would otherwise stack on top of it.
        let t = p.text;
        if (i > 0 && parts[i - 1].code) t = t.replace(/^\n+/, "");
        if (i < parts.length - 1 && parts[i + 1].code) t = t.replace(/\n+$/, "");
        return <span key={i}>{block(t)}</span>;
      })}
    </>
  );
}

/** Split on ATX headings; everything else flows as one pre-wrap run. */
function block(text: string) {
  const out: Array<JSX.Element | string> = [];
  const re = /^(#{1,6})[ \t]+(.+)$/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={`t${k}`}>{inline(text.slice(last, m.index))}</span>);
    const level = Math.min(m[1].length + 2, 6);
    const Tag = `h${level}` as keyof JSX.IntrinsicElements;
    out.push(
      <Tag key={`h${k++}`} className="mdh">
        {inline(m[2])}
      </Tag>,
    );
    last = re.lastIndex;
    // Swallow the newline the heading sat on, so it does not double-space.
    if (text[last] === "\n") last += 1;
  }
  if (last < text.length) out.push(<span key={`t${k}`}>{inline(text.slice(last))}</span>);
  return out;
}

/**
 * Text as one DOM text node per line. While a reply streams, only its last line
 * keeps changing — earlier lines stay the same node, so a selection made in them
 * (to comment on it) survives the tokens still arriving below.
 */
export function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Inline code, bold and italic, in that precedence order. */
function inline(text: string) {
  const out: Array<JSX.Element | string> = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\n]+)\*(?!\w)|__([^_\n]+)__/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...lines(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      out.push(
        <code className="inline" key={k++}>
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined || m[4] !== undefined) {
      // Recurse: bold spans routinely wrap inline code (**`range(4)`**).
      out.push(<b key={k++}>{inline(m[2] ?? m[4])}</b>);
    } else {
      out.push(<i key={k++}>{inline(m[3])}</i>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...lines(text.slice(last)));
  return out;
}
