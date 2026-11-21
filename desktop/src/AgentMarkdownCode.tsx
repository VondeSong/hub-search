import { useState, type ComponentProps } from "react";
import { Code, WrapText } from "lucide-react";
import type { ExtraProps } from "react-markdown";
import { AgentAnswerActions } from "./AgentAnswerActions";

const languageNames: Record<string, string> = {
  powershell: "PowerShell", pwsh: "PowerShell", ps1: "PowerShell",
  python: "Python", py: "Python", javascript: "JavaScript", js: "JavaScript",
  typescript: "TypeScript", ts: "TypeScript", bash: "Bash", shell: "Shell",
  sh: "Shell", json: "JSON", html: "HTML", css: "CSS", sql: "SQL", rust: "Rust",
  text: "纯文本", plaintext: "纯文本",
};

export function AgentMarkdownCode({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const [wrap, setWrap] = useState(false);
  const code = node?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
  const language = Array.isArray(code.properties.className)
    ? code.properties.className.find(name => typeof name === "string" && name.startsWith("language-"))
    : undefined;
  const name = typeof language === "string" ? language.slice("language-".length) : "";
  const normalized = name.toLowerCase();
  const title = (Object.prototype.hasOwnProperty.call(languageNames, normalized) ? languageNames[normalized] : name) || "代码";
  const text = code.children.map(child => child.type === "text" ? child.value : "").join("").replace(/\n$/, "");

  return <div className="agent-markdown-code" data-wrap={wrap}>
    <div className="agent-markdown-code-bar">
      <span className="agent-markdown-code-language"><Code size={15} aria-hidden="true"/>{title}</span>
      <div className="agent-markdown-code-actions">
        <button type="button" aria-pressed={wrap} aria-label="自动换行" title={wrap ? "关闭自动换行" : "自动换行"} onClick={() => setWrap(value => !value)}><WrapText size={15} aria-hidden="true"/></button>
        <AgentAnswerActions text={text} label="代码"/>
      </div>
    </div>
    <pre tabIndex={0} aria-label={title === "代码" ? title : `${title}代码`}>{children}</pre>
  </div>;
}
