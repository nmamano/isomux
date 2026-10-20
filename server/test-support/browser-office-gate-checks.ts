import { expect } from "bun:test";
import type { Page } from "playwright-core";

type Action = (body: Record<string, unknown>) => Promise<{
  status: number;
  body: {
    url?: string;
    title?: string;
    text?: string;
    error?: { code: string; message: string };
  };
}>;

// The office gate in real Chrome (task 2a3b5645). A stand-in office sends the
// office marker and counts what reaches it; the agent's own page takes the
// offered tab there by a timer, the way a hostile page would during an
// auto-waiting click.
export async function checkOfficeGate(opts: {
  officeOrigin: string;
  offeredPage: Page;
  offered: Action;
  offerOfficeTab: () => Promise<Action>;
}) {
  const reached = { documents: 0, clicks: 0 };
  const office = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/hit" && req.method === "POST") {
        reached.clicks++;
        return new Response("ok", { headers: { "X-Isomux-Office": "1" } });
      }
      if (url.pathname === "/") reached.documents++;
      return new Response(
        `<title>Stand-in office</title><button id="office-only" onclick="fetch('/hit',{method:'POST'})">Create token</button>`,
        { headers: { "Content-Type": "text/html", "X-Isomux-Office": "1" } },
      );
    },
  });
  const standIn = `http://127.0.0.1:${office.port}`;
  const agentSite = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const html =
        url.pathname === "/to-office"
          ? `<title>Agent page</title><script>setTimeout(() => { location = ${JSON.stringify(standIn + "/")} }, 500)</script>`
          : "<title>Agent page</title><p>elsewhere</p>";
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    },
  });
  // localhost, not 127.0.0.1: another origin than the stand-in office.
  const site = `http://localhost:${agentSite.port}`;
  try {
    expect(
      (await opts.offered({ action: "goto", url: `${site}/to-office` })).status,
    ).toBe(200);
    // Only the office has this button; Playwright waits for it across the
    // timer's navigation.
    const click = await opts.offered({
      action: "click",
      selector: "#office-only",
    });
    // Give a click that did land time to reach the stand-in.
    await Bun.sleep(1000);
    console.log("Office gate click:", JSON.stringify({ click, reached }));
    expect(reached.documents).toBeGreaterThanOrEqual(1);
    expect(reached.clicks).toBe(0);
    expect(click.status).toBe(403);
    expect(click.body.error?.code).toBe("office_page_refused");
    expect(click.body.url).toBeUndefined();
    expect(click.body.title).toBeUndefined();

    // Leaving the office page works, and the tab is usable again.
    const away = await opts.offered({ action: "goto", url: `${site}/other` });
    expect(away.status).toBe(200);
    expect(away.body.url).toBe(`${site}/other`);

    // The stand-in's origin is now known: refused before Chrome requests it.
    const documents = reached.documents;
    const learned = await opts.offered({ action: "goto", url: `${standIn}/` });
    expect(learned.status).toBe(403);
    expect(learned.body.error?.code).toBe("office_page_refused");
    expect(reached.documents).toBe(documents);

    // This office is known from the start.
    const own = await opts.offered({
      action: "goto",
      url: `${opts.officeOrigin}/`,
    });
    expect(own.status).toBe(403);
    expect(own.body.error?.code).toBe("office_page_refused");
    expect(new URL(opts.offeredPage.url()).origin).toBe(site);

    // A tab the member offered on this office stays usable there, and only
    // there.
    const officeTab = await opts.offerOfficeTab();
    const text = await officeTab({ action: "text" });
    expect(text.status).toBe(200);
    expect(text.body.text?.length).toBeGreaterThan(0);
    const within = await officeTab({
      action: "goto",
      url: `${opts.officeOrigin}/tasks`,
    });
    expect(within.status).toBe(200);
    expect(new URL(within.body.url!).origin).toBe(opts.officeOrigin);
    const other = await officeTab({ action: "goto", url: `${standIn}/` });
    expect(other.status).toBe(403);
    expect(other.body.error?.code).toBe("office_page_refused");
  } finally {
    await office.stop(true);
    await agentSite.stop(true);
  }
}
