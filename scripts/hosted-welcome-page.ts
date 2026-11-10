// isomux.com/hosted-welcome: the Hosted welcome series, built from
// WELCOME_MAILS by the site build (scripts/build-docs.ts writes it to
// site/hosted-welcome.html). The page and the mails share one source and one
// substitution (welcomeMailBody), so what the site shows is what customers
// receive, less the unsubscribe line. The page shell
// follows site/hosted-refund.html.

import {
  WELCOME_MAIL_ADDRESS,
  WELCOME_MAIL_OFFSETS_MS,
  welcomeMailBody,
} from "../control-plane/welcome-mail.ts";
import {
  WELCOME_MAILS,
  WELCOME_MAILS_APPROVED,
} from "../control-plane/welcome-mail-copy.ts";

export const HOSTED_WELCOME_FILE = "hosted-welcome.html";

/** What each placeholder reads as on the page. {dashboardUrl} needs no label:
 * it is the same address for every customer, so the page shows it. */
export const WELCOME_PAGE_LABELS = {
  officeUrl: "your office address",
} as const;

const DAY_MS = 24 * 60 * 60 * 1_000;

// A URL in a mail, less a closing parenthesis or a sentence's last period
// or comma.
const URL_RE = /https:\/\/[^\s<>"()\uE000]*[^\s<>"().,\uE000]/g;

/** A picture under a mail, by step, that a mail links to by its id. The page
 * shows the mail as it reads, so the picture stays hidden until a visitor
 * follows that link (CSS :target, no script). */
const WELCOME_PAGE_FIGURES: Record<
  number,
  { id: string; src: string; alt: string; width: number; height: number }
> = {
  0: {
    id: "home-screen",
    src: "/add-to-home-screen.jpeg",
    alt: "The iPhone browser's Share menu, with Add to Home Screen circled",
    width: 260,
    height: 350,
  },
};

// Stands in for the office address until the text is escaped. Private-use
// characters, so no copy can contain it.
const OFFICE_MARKER = "\uE000office\uE000";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** One mail body as HTML paragraphs. welcomeMailBody throws on a placeholder
 * left unfilled, so none reaches the page raw. */
function bodyHtml(step: number): { subject: string; html: string } {
  const { subject, text } = welcomeMailBody(step, OFFICE_MARKER);
  const html = text
    .split(/\n{2,}/)
    .map((paragraph) => {
      // The URLs are found on the raw text, and each piece is escaped on its
      // own, so a quote or an ampersand next to a URL never joins the link.
      let inner = "";
      let at = 0;
      for (const match of paragraph.matchAll(URL_RE)) {
        const url = escapeHtml(match[0]);
        inner += escapeHtml(paragraph.slice(at, match.index));
        inner += `<a href="${url}">${url}</a>`;
        at = match.index + match[0].length;
      }
      inner += escapeHtml(paragraph.slice(at));
      inner = inner
        .replaceAll("\n", "<br />")
        .replaceAll(
          OFFICE_MARKER,
          `<span class="placeholder">${WELCOME_PAGE_LABELS.officeUrl}</span>`,
        );
      return `        <p>${inner}</p>`;
    })
    .join("\n");
  return { subject, html };
}

function mailsHtml(approved: number): string {
  // Only the mails with approved copy: the others neither send nor show.
  return WELCOME_MAILS.slice(0, approved)
    .map((_, step) => {
      const day = WELCOME_MAIL_OFFSETS_MS[step] / DAY_MS;
      if (!Number.isInteger(day)) {
        throw new Error(
          `welcome mail ${step + 1} is not sent on a whole day (${day})`,
        );
      }
      const { subject, html } = bodyHtml(step);
      const figure = WELCOME_PAGE_FIGURES[step];
      const figureHtml = figure
        ? `\n\n      <figure class="welcome-figure" id="${figure.id}">
        <img src="${figure.src}" alt="${escapeHtml(figure.alt)}" width="${figure.width}" height="${figure.height}" />
      </figure>`
        : "";
      return `      <article class="welcome-mail" data-step="${step}" data-day="${day}">
        <div class="day">Day ${day}</div>
        <h2>${escapeHtml(subject)}</h2>
${html}
      </article>${figureHtml}`;
    })
    .join("\n\n");
}

/** The page. `approved`: how many mails it shows, from the first (a test
 * passes its own count). */
export function renderHostedWelcomePage(
  approved: number = WELCOME_MAILS_APPROVED,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="canonical" href="https://isomux.com/hosted-welcome" />
    <title>Welcome Tips - Hosted Isomux</title>
    <meta
      name="description"
      content="The emails we send a new Hosted Isomux customer in the first weeks of their office."
    />

    <link rel="icon" href="/favicon.png" sizes="192x192" type="image/png" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta
      name="theme-color"
      content="#0d1117"
      media="(prefers-color-scheme: dark)"
    />
    <meta
      name="theme-color"
      content="#f4f6f9"
      media="(prefers-color-scheme: light)"
    />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <script>
      (function () {
        try {
          var saved = localStorage.getItem("isomux-theme");
          if (saved) {
            document.documentElement.setAttribute("data-theme", saved);
            var lightIds = ["light", "solarized-light"];
            document.documentElement.setAttribute(
              "data-theme-mode",
              lightIds.indexOf(saved) >= 0 ? "light" : "dark",
            );
          }
        } catch (e) {}
      })();
    </script>
    <link rel="stylesheet" href="/footer.css" />
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      :root {
        --bg: #0a0e16;
        --bg-surface: #161b22;
        --bg-card: #1c2128;
        --text: #f0f3f6;
        --text-dim: #bcc5d0;
        --accent: #50b86c;
        --border: #30363d;
        --max-width: 760px;
        color-scheme: dark;
      }

      @media (prefers-color-scheme: light) {
        :root {
          --bg: #f4f6f9;
          --bg-surface: #ffffff;
          --bg-card: #eef1f5;
          --text: #1a2030;
          --text-dim: #5a6a80;
          --accent: #16803f;
          --border: #d8dde6;
          color-scheme: light;
        }
      }

      :root[data-theme-mode="dark"] {
        --bg: #0a0e16;
        --bg-surface: #161b22;
        --bg-card: #1c2128;
        --text: #f0f3f6;
        --text-dim: #bcc5d0;
        --accent: #50b86c;
        --border: #30363d;
        color-scheme: dark;
      }
      :root[data-theme-mode="light"] {
        --bg: #f4f6f9;
        --bg-surface: #ffffff;
        --bg-card: #eef1f5;
        --text: #1a2030;
        --text-dim: #5a6a80;
        --accent: #16803f;
        --border: #d8dde6;
        color-scheme: light;
      }

      .theme-toggle {
        position: absolute;
        top: 16px;
        right: 16px;
        z-index: 90;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        border: 1px solid var(--border);
        background: var(--bg-surface);
        color: var(--text-dim);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        transition:
          background 0.15s,
          transform 0.15s;
      }
      .theme-toggle:hover {
        background: var(--bg-card);
        transform: scale(1.06);
      }
      .theme-toggle svg {
        width: 18px;
        height: 18px;
      }

      body {
        font-family:
          "Inter",
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          Helvetica,
          Arial,
          sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.65;
      }

      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }

      h1,
      h2 {
        font-family:
          "Space Grotesk",
          -apple-system,
          sans-serif;
        letter-spacing: -0.01em;
      }

      .topbar {
        max-width: var(--max-width);
        margin: 0 auto;
        padding: 20px 24px 0;
        font-size: 0.9rem;
      }
      .topbar a {
        color: var(--text-dim);
      }

      main {
        max-width: var(--max-width);
        margin: 0 auto;
        padding: 24px 24px 8px;
      }

      h1 {
        font-size: 2rem;
        font-weight: 700;
        margin-bottom: 20px;
      }

      h2 {
        font-size: 1.25rem;
        font-weight: 700;
        margin-top: 30px;
        margin-bottom: 10px;
      }

      p,
      ul {
        margin-bottom: 12px;
      }

      ul {
        padding-left: 20px;
      }
      li {
        margin-bottom: 6px;
      }

      @media (max-width: 640px) {
        main {
          padding: 20px 16px 8px;
        }
        h1 {
          font-size: 1.6rem;
        }
        .topbar {
          padding: 20px 16px 0;
        }
      }

      .intro {
        color: var(--text-dim);
      }

      .welcome-mail {
        background: var(--bg-surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 20px 22px 8px;
        margin: 22px 0;
      }
      .welcome-mail .day {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .welcome-mail h2 {
        margin-top: 2px;
        margin-bottom: 14px;
      }
      .welcome-mail p {
        overflow-wrap: anywhere;
      }
      .placeholder {
        background: var(--bg-card);
        border: 1px dashed var(--border);
        border-radius: 4px;
        padding: 0 5px;
        color: var(--text-dim);
        font-style: italic;
        white-space: nowrap;
      }

      .welcome-figure {
        display: none;
        margin: -8px 0 22px;
      }
      .welcome-figure:target {
        display: block;
      }
      .welcome-figure img {
        display: block;
        width: 260px;
        max-width: 100%;
        height: auto;
        border-radius: 10px;
        border: 1px solid var(--border);
      }

      @media (max-width: 640px) {
        .welcome-mail {
          padding: 16px 16px 6px;
        }
      }
    </style>
  </head>
  <body>
    <div class="topbar"><a href="/hosted">&larr; Hosted Isomux</a></div>

    <main>
      <h1>Welcome Tips</h1>

      <p class="intro">
        When your Hosted Isomux office goes live, I email you these tips from
        ${escapeHtml(WELCOME_MAIL_ADDRESS)}, on the day shown on each. This page
        has the same text as the emails. Each email also has a link to
        unsubscribe.
      </p>

${mailsHtml(approved)}

      <p>
        See also the <a href="/hosted-privacy">privacy policy</a>.
      </p>
    </main>

    <footer class="site-footer">
      <div class="footer-brand">
        <a class="footer-name" href="/">Isomux</a>
      </div>
      <div class="footer-columns">
        <div class="footer-column">
          <h2>Product</h2>
          <ul>
            <li><a href="/hosted">Hosted</a></li>
            <li><a href="/enterprise">Enterprise</a></li>
            <li><a href="/compare">Compare</a></li>
            <li><a href="/docs">Docs</a></li>
            <li><a href="/docs/use-cases">Use cases</a></li>
            <li>
              <a
                href="https://github.com/nmamano/isomux"
                target="_blank"
                rel="noopener"
                >GitHub</a
              >
            </li>
          </ul>
        </div>
        <div class="footer-column">
          <h2>Company</h2>
          <ul>
            <li><a href="/about">About</a></li>
            <li><a href="/contact">Contact</a></li>
            <li><a href="/ai-instructions">AI instructions</a></li>
            <li>
              <a
                href="https://nilmamano.com/blog/category/isomux"
                target="_blank"
                rel="noopener"
                >Blog</a
              >
            </li>
            <li>
              <a href="https://nilmamano.com" target="_blank" rel="noopener"
                >nilmamano.com</a
              >
            </li>
          </ul>
        </div>
        <div class="footer-column">
          <h2>Legal</h2>
          <ul>
            <li><a href="/hosted-terms">Terms</a></li>
            <li><a href="/hosted-privacy">Privacy</a></li>
            <li><a href="/hosted-refund">Refunds</a></li>
          </ul>
        </div>
      </div>
    </footer>

    <script defer src="/analytics.js"></script>
    <script defer src="/theme-toggle.js"></script>
  </body>
</html>
`;
}
