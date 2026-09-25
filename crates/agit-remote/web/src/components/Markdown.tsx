import { Check, Copy } from "lucide-react";
import { memo, useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function CodeBlock(props: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const { children, ...rest } = props;
  delete (rest as Record<string, unknown>).node;
  async function copy() {
    await navigator.clipboard?.writeText(ref.current?.innerText ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="code-block">
      <button className="copy" onClick={() => void copy()} title="复制">
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

function Link(props: ComponentProps<"a">) {
  const { children, ...rest } = props;
  delete (rest as Record<string, unknown>).node;
  return (
    <a {...rest} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const plugins = { remark: [remarkGfm], rehype: [rehypeHighlight] };

/** Raw HTML in agent output is not rendered; react-markdown escapes it by default. */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={plugins.remark} rehypePlugins={plugins.rehype} components={{ pre: CodeBlock, a: Link }}>
        {text}
      </Markdown>
    </div>
  );
});
