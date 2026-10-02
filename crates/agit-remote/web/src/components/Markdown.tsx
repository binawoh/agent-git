import { Check, Copy } from "lucide-react";
import { isValidElement, memo, useRef, useState, type ComponentProps } from "react";
import Markdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { t } from "../i18n";

function CodeBlock(props: ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const { children, ...rest } = props;
  delete (rest as Record<string, unknown>).node;
  const className = isValidElement<{ className?: string }>(children) ? (children.props.className ?? "") : "";
  const language = /language-([\w+#.-]+)/.exec(className)?.[1];
  async function copy() {
    await navigator.clipboard?.writeText(ref.current?.innerText ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language ?? ""}</span>
        <button type="button" className="copy" onClick={() => void copy()} title={t.common.copy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? t.common.copied : t.common.copy}</span>
        </button>
      </div>
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
