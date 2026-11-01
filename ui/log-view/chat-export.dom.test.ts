// The chat's HTML file (task 04d675c0): one page that shows the chosen
// entries, with the page's CSS, and nothing that runs, takes input or points
// at the office. LogView.chat-copy.dom.test.tsx pins the snapshot of the real
// chat; this file pins the page rules on entries built by hand.

import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { buildChatHtml, chatExportFileName, collectExportCss } =
  await import("./chat-export.ts");
const { activeContentIn, officeUrlsIn, parseExport } =
  await import("../test-support/export-html.ts");

const OFFICE = location.origin;

// Log wrappers as snapshotChatEntries returns them: detached clones.
function entries(...html: string[]): HTMLElement[] {
  return html.map((inner, i) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-log-entry-id", `e${i}`);
    wrapper.innerHTML = inner;
    return wrapper;
  });
}

const base = {
  title: "Isomux Worker 1",
  exportedAt: new Date(2026, 10, 1, 12, 0).getTime(),
  language: "es",
  theme: "night",
  themeMode: "dark",
  css: ".from-the-page { color: red; }",
};

it("is one page with the entries in order, the page's CSS and the theme, and no script", async () => {
  const html = await buildChatHtml({
    ...base,
    entries: entries("<p>First entry</p>", "<p>Second entry</p>"),
  });
  expect(html.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(
    true,
  );
  const doc = parseExport(html);
  const root = doc.documentElement;
  expect(root.getAttribute("lang")).toBe("es");
  expect(root.getAttribute("data-theme")).toBe("night");
  expect(root.getAttribute("data-theme-mode")).toBe("dark");
  expect(doc.title).toBe("Isomux Worker 1");
  // The header names the agent, before the entries.
  const text = doc.body.textContent ?? "";
  const at = ["Isomux Worker 1", "First entry", "Second entry"].map((s) =>
    text.indexOf(s),
  );
  expect(at.every((i) => i >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  const styles = Array.from(doc.querySelectorAll("style")).map(
    (s) => s.textContent ?? "",
  );
  expect(styles.some((css) => css.includes(".from-the-page"))).toBe(true);
  expect(activeContentIn(html)).toEqual([]);
});

it("keeps outside links, drops links into the office with their text kept, and leaves no office URL", async () => {
  const html = await buildChatHtml({
    ...base,
    entries: entries(
      `<p>
        <a href="https://example.com/doc">outside</a>
        <a href="mailto:someone@example.com">mail</a>
        <a href="/tasks/abc">relative</a>
        <a href="${OFFICE}/agents/a1">same origin</a>
        <a href="#top">fragment</a>
        <a href="javascript:alert(1)">script link</a>
      </p>`,
      `<img srcset="/api/files/a1/x.png 2x" alt="srcset image">
       <picture><source srcset="/api/files/a1/y.png"><img alt="picture image" src="data:image/png;base64,AAAA"></picture>
       <video src="/api/files/a1/v.mp4" poster="/api/files/a1/p.png"></video>
       <audio src="${OFFICE}/api/files/a1/a.mp3"></audio>
       <div style="background-image: url('/api/files/a1/bg.png'); color: red">styled</div>`,
      `<svg viewBox="0 0 10 10">
         <defs><marker id="arrow"><path d="M0 0"/></marker><symbol id="icon"><path d="M1 1"/></symbol></defs>
         <path d="M0 0L5 5" marker-end="url(#arrow)"/>
         <use href="#icon"/>
         <use href="https://evil.example/sprite.svg#x"/>
         <image href="/api/files/a1/i.png"/>
       </svg>`,
    ),
  });
  expect(officeUrlsIn(html, OFFICE)).toEqual([]);
  const doc = parseExport(html);
  const outside = doc.querySelector('a[href="https://example.com/doc"]');
  expect(outside?.textContent).toBe("outside");
  expect(outside?.getAttribute("target")).toBe("_blank");
  expect(outside?.getAttribute("rel") ?? "").toContain("noopener");
  expect(doc.querySelector('a[href="mailto:someone@example.com"]')).not.toBe(
    null,
  );
  const text = doc.body.textContent ?? "";
  for (const kept of [
    "relative",
    "same origin",
    "fragment",
    "script link",
    "styled",
  ])
    expect(text).toContain(kept);
  // The inline style keeps what is not a URL.
  expect(
    Array.from(doc.querySelectorAll<HTMLElement>("div")).find(
      (d) => d.textContent === "styled",
    )?.style.color,
  ).toBe("red");
  // References inside the file stay: SVG markers and icons.
  expect(doc.querySelector('[marker-end="url(#arrow)"]')).not.toBeNull();
  expect(doc.querySelector('use[href="#icon"]')).not.toBeNull();
  // An outside sprite or image would load when the file opens.
  expect(html).not.toContain("evil.example");
  // An image already in the file stays.
  expect(
    doc.querySelector('img[alt="picture image"]')?.getAttribute("src"),
  ).toBe("data:image/png;base64,AAAA");
});

it("leaves out what runs or takes input, keeps buttons inert, and drops what the chat marks", async () => {
  const [entry] = entries(
    `<div onclick="alert(1)" onmouseover="x()">
         <button onclick="alert(2)">Tool card head</button>
         <form action="/api/x"><input value="secret draft"><textarea>draft</textarea><select><option>o</option></select></form>
         <script>alert(3)</script>
         <iframe src="https://example.com"></iframe>
         <object data="/x.swf"></object><embed src="/x.swf">
         <svg><foreignObject><div onclick="y()">in svg</div></foreignObject></svg>
         <span data-chat-export="omit">Copy control</span>
         <p>Kept text</p>
       </div>`,
  );
  // happy-dom's HTML parser cannot put a <script> in an <svg>: built by hand.
  const SVG = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG, "svg");
  const svgScript = document.createElementNS(SVG, "script");
  svgScript.textContent = "alert(4)";
  svg.appendChild(svgScript);
  entry.appendChild(svg);
  entry.append("After the svg");
  expect(entry.innerHTML).toContain("<script>alert(4)</script>");
  const html = await buildChatHtml({ ...base, entries: [entry] });
  expect(activeContentIn(html)).toEqual([]);
  expect(officeUrlsIn(html, OFFICE)).toEqual([]);
  const doc = parseExport(html);
  const text = doc.body.textContent ?? "";
  expect(text).toContain("Kept text");
  expect(text).toContain("in svg");
  expect(text).toContain("After the svg");
  expect(text).not.toContain("Copy control");
  expect(text).not.toContain("alert(");
  expect(text).not.toContain("secret draft");
  // A card's head is a button: it stays, and does nothing.
  const head = Array.from(doc.querySelectorAll("button")).find(
    (b) => b.textContent === "Tool card head",
  );
  expect(head).toBeDefined();
  expect(head!.hasAttribute("disabled")).toBe(true);
  expect(head!.getAttribute("type")).toBe("button");
});

it("inlines each office image the fetcher returns, and puts the name of the others in their place", async () => {
  const asked: string[] = [];
  const html = await buildChatHtml({
    ...base,
    entries: entries(
      `<img src="/api/files/a1/ok.png" alt="kept-shot.png">
       <img src="/api/files/a1/gone.png" alt="lost-shot.png">`,
    ),
    fetchImage: async (src) => {
      asked.push(src);
      return src.includes("ok.png") ? "data:image/png;base64,iVBORw0K" : null;
    },
  });
  expect(asked.some((s) => s.includes("ok.png"))).toBe(true);
  expect(asked.some((s) => s.includes("gone.png"))).toBe(true);
  expect(officeUrlsIn(html, OFFICE)).toEqual([]);
  const doc = parseExport(html);
  expect(
    doc.querySelector('img[alt="kept-shot.png"]')?.getAttribute("src"),
  ).toBe("data:image/png;base64,iVBORw0K");
  expect(doc.querySelector('img[alt="lost-shot.png"]')).toBeNull();
  expect(doc.body.textContent).toContain("lost-shot.png");

  // With no fetcher, an office image is its name.
  const bare = await buildChatHtml({
    ...base,
    entries: entries(`<img src="/api/files/a1/ok.png" alt="kept-shot.png">`),
  });
  expect(officeUrlsIn(bare, OFFICE)).toEqual([]);
  expect(parseExport(bare).body.textContent).toContain("kept-shot.png");
});

it("collects the page's CSS rules, theme variables and media rules included", () => {
  const style = document.createElement("style");
  style.textContent = `
    [data-theme="night"] { --bg-base: #010203; }
    .export-probe { color: rgb(1, 2, 3); }
    @media (max-width: 600px) { .export-probe-narrow { color: blue; } }`;
  document.head.appendChild(style);
  try {
    const css = collectExportCss(document);
    expect(css).toContain("--bg-base");
    expect(css).toContain(".export-probe");
    expect(css).toContain(".export-probe-narrow");
  } finally {
    style.remove();
  }
});

it("leaves out font faces, imports and a sheet it may not read", () => {
  // happy-dom drops @font-face and @import when it parses, so these rules
  // come as a browser lists them: cssText and the CSSRule type number.
  const rule = (type: number, cssText: string) => ({ type, cssText });
  const doc = {
    styleSheets: [
      {
        cssRules: [
          rule(3, '@import url("/fonts.css");'),
          rule(
            5,
            '@font-face { font-family: "JetBrains Mono"; src: url("/fonts/jb.woff2"); }',
          ),
          rule(1, ".kept-rule { color: red; }"),
        ],
      },
      {
        // A sheet from another origin: the browser throws on cssRules.
        get cssRules(): never {
          throw new DOMException("cross origin", "SecurityError");
        },
      },
      { cssRules: [rule(1, ".second-sheet { color: blue; }")] },
    ],
  } as unknown as Document;
  const css = collectExportCss(doc);
  expect(css).toContain(".kept-rule");
  expect(css).toContain(".second-sheet");
  expect(css).not.toContain("@import");
  expect(css).not.toContain("@font-face");
  expect(css).not.toContain("/fonts");
});

it("names the file after the agent and the day", () => {
  const at = new Date(2026, 10, 1, 12, 0).getTime();
  expect(chatExportFileName("Isomux Worker 1", at)).toBe(
    "isomux-worker-1-chat-2026-11-01.html",
  );
  // A name with no letter a file name can keep.
  expect(chatExportFileName("工人", at)).toBe("chat-2026-11-01.html");
});
