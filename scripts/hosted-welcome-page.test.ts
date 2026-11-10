// isomux.com/hosted-welcome shows the welcome mails as customers receive them
// (task 733ed11b): the page the site build writes is compared with what the
// sender renders, mail by mail, so the two cannot differ.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { Window, type Element as PageElement } from "happy-dom";
import {
  WELCOME_MAILS,
  WELCOME_MAILS_APPROVED,
  type WelcomeMailCopy,
} from "../control-plane/welcome-mail-copy.ts";
import {
  WELCOME_MAIL_OFFSETS_MS,
  renderWelcomeMail,
  sendWelcomeMail,
} from "../control-plane/welcome-mail.ts";
import { main as buildDocs } from "./build-docs.ts";
import { renderHostedWelcomePage } from "./hosted-welcome-page.ts";

const DAY = 24 * 60 * 60 * 1_000;
const OFFICE = "https://office-under-test.isomux.app";
// The page with every mail on it, approved or not: what it shows once all
// the copy ships.
const ALL = WELCOME_MAILS.length;

let window: Window;
let built: string;
// The page rendered with every mail, parsed.
let full: Window;
beforeAll(() => {
  // A page left by an earlier build must not stand in for this one.
  rmSync("site/hosted-welcome.html", { force: true });
  buildDocs();
  built = readFileSync("site/hosted-welcome.html", "utf8");
  window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  window.document.write(built);
  full = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  full.document.write(renderHostedWelcomePage(ALL));
});
afterAll(async () => {
  await window.happyDOM.close();
  await full.happyDOM.close();
});

/** The mail articles of each page under test: the built one (approved mails
 * only) and the one with every mail. */
function pages(): [string, PageElement[], number][] {
  return [
    [
      "built",
      [...window.document.querySelectorAll("article.welcome-mail")],
      WELCOME_MAILS_APPROVED,
    ],
    ["all", [...full.document.querySelectorAll("article.welcome-mail")], ALL],
  ];
}

/** A body paragraph as plain text, with the office placeholder read back as
 * OFFICE and each line break as a newline. */
function paragraphText(p: PageElement): string {
  const copy = p.cloneNode(true) as PageElement;
  const doc = p.ownerDocument;
  for (const span of copy.querySelectorAll(".placeholder")) {
    span.replaceWith(doc.createTextNode(OFFICE));
  }
  for (const br of copy.querySelectorAll("br")) {
    br.replaceWith(doc.createTextNode("\n"));
  }
  return copy.textContent ?? "";
}

/** What the sender sends for `step`, less the unsubscribe and address footer. */
function sentMail(step: number) {
  const { subject, text } = renderWelcomeMail(step, {
    officeUrl: OFFICE,
    unsubscribeToken: "token",
  });
  return { subject, body: text.slice(0, text.lastIndexOf("\n\n--\n")) };
}

/** Run `fn` with the body of mail `step` changed to `body`, then restore it. */
function withBody<T>(step: number, body: string, fn: () => T): T {
  const mail = WELCOME_MAILS[step] as WelcomeMailCopy;
  const before = mail.body;
  mail.body = body;
  try {
    return fn();
  } finally {
    mail.body = before;
  }
}

describe("the welcome tips page", () => {
  it("is what the site build writes", () => {
    expect(built).toBe(renderHostedWelcomePage());
  });

  it("shows each mail as it is sent: its day, subject and text, in order", () => {
    expect(ALL).toBe(WELCOME_MAIL_OFFSETS_MS.length);
    for (const [name, articles, count] of pages()) {
      expect([name, articles.length]).toEqual([name, count]);
      articles.forEach((article, step) => {
        const sent = sentMail(step);
        const day = article.querySelector(".day")?.textContent ?? "";
        expect([step, day.match(/\d+/g)]).toEqual([
          step,
          [String(WELCOME_MAIL_OFFSETS_MS[step] / DAY)],
        ]);
        expect([step, article.querySelector("h2")?.textContent]).toEqual([
          step,
          sent.subject,
        ]);
        const body = [...article.querySelectorAll("p")]
          .map(paragraphText)
          .join("\n\n");
        expect([step, body]).toEqual([step, sent.body]);
        // Each link goes where its text says.
        for (const a of article.querySelectorAll("a")) {
          expect(a.getAttribute("href")).toBe(a.textContent);
        }
      });
    }
  });

  it("shows no mail whose copy is not approved", () => {
    // A draft must not be public before Nil approves it.
    expect(WELCOME_MAILS_APPROVED).toBeLessThanOrEqual(ALL);
    const text = window.document.querySelector("main")?.textContent ?? "";
    for (let step = WELCOME_MAILS_APPROVED; step < ALL; step++) {
      expect([step, text.includes(WELCOME_MAILS[step].subject)]).toEqual([
        step,
        false,
      ]);
    }
    for (let step = 0; step < WELCOME_MAILS_APPROVED; step++) {
      expect([step, text.includes(WELCOME_MAILS[step].subject)]).toEqual([
        step,
        true,
      ]);
    }
  });

  it("links every web address in a mail, to that address", () => {
    for (const [, articles] of pages()) {
      articles.forEach((article, step) => {
        // An address ends at a space; a closing parenthesis or a sentence's
        // last period or comma after it is not part of it. The office address
        // differs per customer: the page shows its placeholder instead.
        const sent = (sentMail(step).body.match(/https:\/\/\S+/g) ?? [])
          .map((url) => url.replace(/[).,]+$/, ""))
          .filter((url) => url !== OFFICE);
        const hrefs = [...article.querySelectorAll("a")].map((a) =>
          a.getAttribute("href"),
        );
        expect([step, hrefs]).toEqual([step, sent]);
      });
    }
  });

  it("has what a mail's link into this page points at", () => {
    const page = "https://isomux.com/hosted-welcome#";
    const targets = [
      ...window.document.querySelectorAll("article.welcome-mail a"),
    ]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.startsWith(page))
      .map((href) => href.slice(page.length));
    // Mail 1 links its Add to Home Screen picture. If the copy drops that
    // link, drop this line.
    expect(targets.length).toBeGreaterThan(0);
    for (const id of targets) {
      const target = window.document.getElementById(id);
      expect([id, target !== null]).toEqual([id, true]);
      for (const img of target?.querySelectorAll("img") ?? []) {
        const src = img.getAttribute("src") ?? "";
        expect([src, existsSync(`site${src}`)]).toEqual([src, true]);
      }
    }
  });

  // Nil, 2026-11-10: the page reads as the mail does, so a picture a mail
  // links to is not shown under it; following the link shows it.
  // MUTANTS: the figure never hidden (dies on the plain visit); hidden even
  // when targeted (dies on the visit with the anchor).
  it("shows a picture a mail links to only when the visit follows that link", () => {
    const page = "https://isomux.com/hosted-welcome";
    const ids = [...window.document.querySelectorAll("article.welcome-mail a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.startsWith(`${page}#`))
      .map((href) => href.slice(page.length + 1));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids)
      for (const [url, shown] of [
        [page, false],
        [`${page}#${id}`, true],
      ] as const) {
        const w = new Window({
          url,
          settings: {
            disableJavaScriptEvaluation: true,
            disableCSSFileLoading: true,
          },
        });
        w.document.write(built);
        const target = w.document.getElementById(id)!;
        expect([url, w.getComputedStyle(target).display !== "none"]).toEqual([
          url,
          shown,
        ]);
        void w.happyDOM.close();
      }
  });

  it("keeps a link whole beside quotes and an ampersand, and markup-like text as text", () => {
    // "&copy" reads as an entity unless it is escaped.
    const url = "https://example.com/a?b=1&copy=2";
    const body = `Open <Settings> & see "${url}", then <Members> & more.`;
    const page = withBody(1, body, () => renderHostedWelcomePage(ALL));
    const w = new Window({
      settings: { disableJavaScriptEvaluation: true },
    });
    w.document.write(page);
    const p = w.document.querySelector('article[data-step="1"] p')!;
    const a = p.querySelector("a");
    expect([a?.getAttribute("href"), a?.textContent]).toEqual([url, url]);
    expect(paragraphText(p)).toBe(body);
    void w.happyDOM.close();
  });

  it("shows no placeholder in its raw form", () => {
    expect(window.document.querySelector("main")?.textContent).not.toMatch(
      /[{}]/,
    );
    expect(
      window.document.querySelectorAll("article .placeholder").length,
    ).toBeGreaterThan(0);
  });

  it("keeps a line break inside a paragraph", () => {
    const page = withBody(1, "One line\nthe next line", () =>
      renderHostedWelcomePage(ALL),
    );
    const w = new Window({
      settings: { disableJavaScriptEvaluation: true },
    });
    w.document.write(page);
    const p = w.document.querySelector('article[data-step="1"] p')!;
    expect(paragraphText(p)).toBe("One line\nthe next line");
    void w.happyDOM.close();
  });
});

describe("a placeholder the sender cannot fill", () => {
  const BODY = "Open {inviteUrl} to start.";

  it("stops the page build", () => {
    expect(() =>
      withBody(2, BODY, () => renderHostedWelcomePage(ALL)),
    ).toThrow();
  });

  it("is never sent", async () => {
    let requests = 0;
    const mail = WELCOME_MAILS[2] as WelcomeMailCopy;
    const before = mail.body;
    mail.body = BODY;
    let result: Awaited<ReturnType<typeof sendWelcomeMail>>;
    try {
      result = await sendWelcomeMail(
        {
          to: "owner@example.com",
          step: 2,
          officeUrl: OFFICE,
          unsubscribeToken: "token",
        },
        {
          apiKey: "re_test",
          fetch: (async () => {
            requests++;
            return new Response("{}", { status: 200 });
          }) as unknown as typeof fetch,
        },
      );
    } finally {
      mail.body = before;
    }
    expect(result.ok).toBe(false);
    expect(requests).toBe(0);
  });
});

it("a step that is not a whole number of days stops the page build", () => {
  const offsets = WELCOME_MAIL_OFFSETS_MS as number[];
  const before = offsets[1];
  offsets[1] = 1.5 * DAY;
  try {
    expect(() => void renderHostedWelcomePage(ALL)).toThrow();
  } finally {
    offsets[1] = before;
  }
});
