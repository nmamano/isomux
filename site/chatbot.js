// Shared chat widget. Loaded by site/index.html (landing chatbot), its Spanish
// and Catalan copies under site/es and site/ca, and the per-page docs chatbot
// rendered by scripts/build-docs.ts.
//
// Page-specific context: if `window.__docContext` is set (a string of raw
// markdown for the current docs page), it's sent to /api/chat as
// `pageContext`, which the API appends to the system prompt so the bot can
// answer questions about the current docs page accurately.
//
// The widget's own fixed labels follow the page's `<html lang>`; any other
// value falls back to English. The bot's answers come from /api/chat and are
// not touched here. A starter button is both a label and the message it sends,
// so a translated starter asks its question in that language.

(function () {
  const chatSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const closeSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const sendSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;

  // Read embedded page context once at load. Docs pages set
  // window.__docContext to the raw markdown for the current page; the
  // landing has no such variable and pageContext stays empty.
  const pageContext =
    typeof window.__docContext === "string" ? window.__docContext.trim() : "";
  // Which page kind /api/chat is told about. A language copy of a page lives
  // under its own directory (site/es, site/ca), so the prefix comes off before
  // the classification: /es/hosted is the hosted page, not the landing. Keep
  // the codes in step with SUPPORTED_LANGUAGES in shared/languages.ts; English
  // has no prefix.
  const LANGUAGE_PREFIX = /^\/(?:es|ca)(?=\/|$)/;
  const pagePath = window.location.pathname.replace(LANGUAGE_PREFIX, "");
  const page = pagePath.startsWith("/hosted") ? "hosted" : "main";

  const LABELS = {
    en: {
      pageStarters: [
        "Summarize this page",
        "What's not covered here?",
        "How does this relate to the rest of Isomux?",
        "What is Isomux?",
      ],
      starters: [
        "What is Isomux?",
        "How do I get started?",
        "What features does it have?",
        "Does it work on mobile?",
      ],
      pageIntro: "Ask me about this page or Isomux!",
      intro: "Ask me anything about Isomux!",
      header: "Ask about Isomux",
      placeholder: "Type a message...",
      powered: "Powered by Claude",
      noCredits: "The chatbot has run out of credits. Please try again later!",
      failed: "Something went wrong. Please try again.",
    },
    es: {
      pageStarters: [
        "Resume esta página",
        "¿Qué no cubre?",
        "¿Cómo encaja esto en el resto de Isomux?",
        "¿Qué es Isomux?",
      ],
      starters: [
        "¿Qué es Isomux?",
        "¿Cómo empiezo?",
        "¿Qué funciones tiene?",
        "¿Funciona en el móvil?",
      ],
      pageIntro: "¡Pregúntame sobre esta página o sobre Isomux!",
      intro: "¡Pregúntame lo que quieras sobre Isomux!",
      header: "Pregunta sobre Isomux",
      placeholder: "Escribe un mensaje...",
      powered: "Funciona con Claude",
      noCredits: "El chatbot se ha quedado sin crédito. ¡Inténtalo más tarde!",
      failed: "Algo ha ido mal. Inténtalo otra vez.",
    },
    ca: {
      pageStarters: [
        "Resumeix aquesta pàgina",
        "Què no cobreix?",
        "Com encaixa això amb la resta d'Isomux?",
        "Què és Isomux?",
      ],
      starters: [
        "Què és Isomux?",
        "Com començo?",
        "Quines funcions té?",
        "Funciona al mòbil?",
      ],
      pageIntro: "Pregunta'm sobre aquesta pàgina o sobre Isomux!",
      intro: "Pregunta'm el que vulguis sobre Isomux!",
      header: "Pregunta sobre Isomux",
      placeholder: "Escriu un missatge...",
      powered: "Funciona amb Claude",
      noCredits:
        "El chatbot s'ha quedat sense crèdit. Torna-ho a provar més tard!",
      failed: "Alguna cosa ha anat malament. Torna-ho a provar.",
    },
  };
  const L = LABELS[document.documentElement.lang] || LABELS.en;

  const starters = pageContext ? L.pageStarters : L.starters;

  let messages = [];
  let isOpen = false;
  let isLoading = false;

  const container = document.getElementById("chat-widget");

  function formatText(text) {
    // Extract code first so other transforms don't mangle its contents.
    // Restore at the end with HTML-escaped bodies.
    const blocks = [];
    const inlines = [];
    text = text.replace(
      /```[^\n`]*\n?([\s\S]*?)```/g,
      (_, code) => `\x00B${blocks.push(code) - 1}\x00`,
    );
    text = text.replace(
      /`([^`\n]+)`/g,
      (_, code) => `\x00I${inlines.push(code) - 1}\x00`,
    );
    text = text
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>',
      )
      .replace(
        /(^|[^"'>])(https?:\/\/[^\s<)]+)/g,
        '$1<a href="$2" target="_blank" rel="noopener">$2</a>',
      );
    text = text.replace(
      /\x00B(\d+)\x00/g,
      (_, i) => `<pre><code>${esc(blocks[+i].replace(/\n$/, ""))}</code></pre>`,
    );
    text = text.replace(
      /\x00I(\d+)\x00/g,
      (_, i) => `<code>${esc(inlines[+i])}</code>`,
    );
    return text;
  }

  function render() {
    if (!container) return;
    if (!isOpen) {
      container.innerHTML = `<button class="chat-btn" onclick="window.__chatOpen()">${chatSvg}</button>`;
      return;
    }

    let msgsHtml = "";
    if (messages.length === 0) {
      msgsHtml = `<div class="chat-starters">
          <p>${pageContext ? L.pageIntro : L.intro}</p>
          ${starters.map((q) => `<button class="chat-starter-btn" onclick="window.__chatSend('${q.replace(/'/g, "\\'")}')">${q}</button>`).join("")}
        </div>`;
    } else {
      msgsHtml = messages
        .map(
          (m) =>
            `<div class="chat-msg chat-msg-${m.role === "user" ? "user" : "bot"}">${m.role === "user" ? esc(m.content) : formatText(m.content)}</div>`,
        )
        .join("");
      if (isLoading && messages[messages.length - 1]?.role === "user") {
        msgsHtml += `<div class="chat-loading"><span></span><span></span><span></span></div>`;
      }
    }

    container.innerHTML = `
        <div class="chat-panel">
          <div class="chat-header">
            <div class="chat-header-left">${chatSvg} ${L.header}</div>
            <button class="chat-close" onclick="window.__chatClose()">${closeSvg}</button>
          </div>
          <div class="chat-messages" id="chat-msgs">${msgsHtml}</div>
          <div class="chat-footer">
            <form class="chat-form" onsubmit="event.preventDefault(); window.__chatSubmit()">
              <input class="chat-input" id="chat-input" placeholder="${L.placeholder}" ${isLoading ? "disabled" : ""} autocomplete="off" />
              <button class="chat-send" type="submit" ${isLoading ? "disabled" : ""}>${sendSvg}</button>
            </form>
            <div class="chat-powered">${L.powered}</div>
          </div>
        </div>`;

    const msgsEl = document.getElementById("chat-msgs");
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
    const inputEl = document.getElementById("chat-input");
    if (inputEl && !isLoading) inputEl.focus();
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  async function sendMessage(text) {
    if (!text.trim() || isLoading) return;
    messages.push({ role: "user", content: text });
    isLoading = true;
    render();

    try {
      const body = {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        page,
      };
      if (pageContext) body.pageContext = pageContext;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || err.error || "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let botMsg = { role: "assistant", content: "" };
      messages.push(botMsg);
      isLoading = false;

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) {
              botMsg.content += parsed.text;
              render();
            }
          } catch (e) {
            if (e.message && !e.message.includes("JSON")) throw e;
          }
        }
      }
      render();
    } catch (err) {
      isLoading = false;
      const errorText =
        err.message?.includes("credit") || err.message?.includes("balance")
          ? L.noCredits
          : L.failed;
      messages.push({
        role: "assistant",
        content: errorText,
        error: true,
      });
      render();
    }
  }

  window.__chatOpen = () => {
    isOpen = true;
    render();
  };
  window.__chatClose = () => {
    isOpen = false;
    render();
  };
  window.__chatSubmit = () => {
    const input = document.getElementById("chat-input");
    if (input) {
      sendMessage(input.value);
    }
  };
  window.__chatSend = (text) => {
    sendMessage(text);
  };

  render();
})();
