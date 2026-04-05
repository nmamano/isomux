import { useMemo, useCallback } from "react";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import diff from "highlight.js/lib/languages/diff";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);

const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      // Auto-detect for unlabeled code blocks
      return hljs.highlightAuto(code).value;
    },
  })
);

marked.setOptions({
  breaks: true,
  gfm: true,
});

// Override link renderer to always open in new tab
const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
marked.use({ renderer });

const COPY_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"/></svg>`;
const CHECK_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg>`;
const COPY_BTN_HTML = `<button class="copy-btn code-copy-btn" title="Copy">${COPY_SVG}</button>`;

export function Markdown({ content }: { content: string }) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(content) as string;
      // Wrap <pre> blocks in a container so the copy button stays fixed outside the scroll area
      return raw.replace(/<pre>/g, `<div class="code-block-wrapper">${COPY_BTN_HTML}<pre>`).replace(/<\/pre>/g, `</pre></div>`);
    } catch {
      return content;
    }
  }, [content]);

  // Handle copy button clicks via event delegation
  const onClick = useCallback(async (e: React.MouseEvent) => {
    const btn = (e.target as HTMLElement).closest(".code-copy-btn");
    if (!btn) return;
    e.stopPropagation();
    const wrapper = btn.closest(".code-block-wrapper");
    const pre = wrapper?.querySelector("pre");
    if (!pre) return;
    const code = pre.querySelector("code");
    const text = code ? code.textContent ?? "" : pre.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    btn.innerHTML = CHECK_SVG;
    (btn as HTMLElement).style.color = "var(--green)";
    (btn as HTMLElement).style.background = "var(--green-bg)";
    setTimeout(() => {
      btn.innerHTML = COPY_SVG;
      (btn as HTMLElement).style.color = "";
      (btn as HTMLElement).style.background = "";
    }, 1500);
  }, []);

  return (
    <div
      className="md-content"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
