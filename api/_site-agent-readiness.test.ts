import { describe, expect, it } from "bun:test";
import chat from "./chat.ts";
import notFound from "./not-found.ts";
import middleware, { negotiate } from "../middleware.ts";
import { STATIC_PATHS, rewriteMarkdownLinks } from "../scripts/build-docs.ts";

/** Every JSON-LD block in a page, in order. */
function jsonLdBlocks(html: string): Record<string, any>[] {
  return [
    ...html.matchAll(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
    ),
  ].map(([, json]) => JSON.parse(json));
}

/**
 * How isomux.com serves a link target: a file under site/, a docs page built
 * from docs/, or a vercel.json rewrite. Null when nothing serves it.
 */
async function resolves(
  href: string,
  vercel: { rewrites: { source: string }[] },
): Promise<"file" | "doc" | "rewrite" | null> {
  const url = new URL(href, "https://isomux.com");
  if (url.origin !== "https://isomux.com") return null;
  const path = url.pathname;
  if (vercel.rewrites.some((r) => r.source === path)) return "rewrite";
  if (path === "/docs") return "doc";
  const doc = path.match(/^\/docs\/([^/]+)$/);
  if (doc) return (await Bun.file(`docs/${doc[1]}.md`).exists()) ? "doc" : null;
  if (path !== "/" && (await Bun.file(`site${path}`).exists())) return "file";
  return null;
}

describe("isomux.com agent readiness", () => {
  it("negotiates Markdown with q-values and rejects unsupported types", () => {
    expect(negotiate("text/markdown, text/html;q=0.8")).toBe("text/markdown");
    expect(negotiate("text/markdown, text/html")).toBe("text/markdown");
    expect(negotiate("text/html, text/markdown")).toBe("text/html");
    expect(negotiate("text/markdown;q=0.2, text/html;q=0.9")).toBe("text/html");
    expect(
      negotiate("text/markdown;q=0.2, text/markdown;q=0.9, text/html;q=0.8"),
    ).toBe("text/markdown");
    expect(negotiate("text/markdown;q=0, */*;q=0.5")).toBe("text/html");
    expect(negotiate("application/pdf")).toBeNull();
  });

  it("rewrites Markdown requests and marks both variants as negotiated", () => {
    const markdown = middleware(
      new Request("https://isomux.com/docs/hosting", {
        headers: { Accept: "text/markdown" },
      }),
    );
    expect(markdown.headers.get("x-middleware-rewrite")).toBe(
      "https://isomux.com/_agent/docs/hosting/index.md",
    );
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("vary")).toBe("Accept, Accept-Encoding");

    const html = middleware(
      new Request("https://isomux.com/docs/hosting", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(html.headers.get("x-middleware-next")).toBe("1");
    expect(html.headers.get("vary")).toBe("Accept, Accept-Encoding");

    const unsupported = middleware(
      new Request("https://isomux.com/docs", {
        headers: { Accept: "application/pdf" },
      }),
    );
    expect(unsupported.status).toBe(406);
  });

  it("returns a recoverable Markdown 404 for unknown pages", async () => {
    const response = notFound(
      new Request("https://isomux.com/missing", {
        headers: { Accept: "text/markdown" },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(await response.text()).toContain("https://isomux.com/llms.txt");
  });

  it("returns an HTML 404 to browsers without changing the status", async () => {
    const response = notFound(
      new Request("https://isomux.com/missing", {
        headers: { Accept: "text/html" },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("vary")).toBe("Accept, Accept-Encoding");
    expect(await response.text()).toContain(
      "<title>Page not found | Isomux</title>",
    );
  });

  it("returns a structured JSON 404 for unknown API routes", async () => {
    const response = notFound(
      new Request("https://isomux.com/api/not-found?path=api/missing"),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "not_found",
        message: "No API endpoint exists at /api/missing.",
        resolution:
          "Read https://isomux.com/openapi.json for supported endpoints.",
      },
    });
  });

  it("publishes valid discovery files for every public website API", async () => {
    const spec = JSON.parse(await Bun.file("site/openapi.json").text());
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(["/api/chat"]);
    expect(spec.paths["/api/chat"].post.description).toContain("Isomux");
    expect(spec.paths["/api/chat"].post.responses["405"]).toBeDefined();
    expect(
      spec.components.schemas.ChatRequest.properties.messages.minItems,
    ).toBe(1);

    const llms = await Bun.file("site/llms.txt").text();
    expect(llms).toContain("https://isomux.com/openapi.json");
    expect(llms).toContain("https://isomux.com/docs/developer-api");

    const vercel = JSON.parse(await Bun.file("vercel.json").text());
    expect(vercel.rewrites[0]).toEqual({
      source: "/.well-known/security.txt",
      destination: "/security.txt",
    });
    expect(vercel.rewrites.at(-1)).toEqual({
      source: "/:path*",
      destination: "/api/not-found?path=:path*",
    });

    const homepage = await Bun.file("site/index.html").text();
    const match = homepage.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    const metaDescription = homepage.match(
      /<meta\s+name="description"\s+content="([^"]+)"/,
    );
    expect(match).not.toBeNull();
    expect(metaDescription).not.toBeNull();
    expect(JSON.parse(match![1])).toMatchObject({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Isomux",
      description: metaDescription![1],
      url: "https://isomux.com/",
      sameAs: ["https://github.com/nmamano/isomux"],
    });

    const security = await Bun.file("site/security.txt").text();
    expect(security).toContain("Contact: mailto:llc@isomux.com");
    expect(security).toContain(
      "Canonical: https://isomux.com/.well-known/security.txt",
    );
  });

  it("publishes the about page with structured company facts", async () => {
    const about = await Bun.file("site/about.html").text();
    const canonical = about.match(/<link rel="canonical" href="([^"]+)"/);
    const jsonLd = about.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    expect(canonical).not.toBeNull();
    expect(jsonLd).not.toBeNull();
    const data = JSON.parse(jsonLd![1]);
    expect(data["@type"]).toBe("AboutPage");
    expect(data.url).toBe(canonical![1]);
    expect(data.mainEntity["@type"]).toBe("Organization");
    expect(data.mainEntity.founder["@type"]).toBe("Person");
    expect(data.mainEntity.foundingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const llms = await Bun.file("site/llms.txt").text();
    expect(llms).toContain(canonical![1]);
  });

  for (const file of [
    "site/ai-instructions.html",
    "site/contact.html",
    "site/compare.html",
  ]) {
    it(`links ${file} from the sitemap, llms.txt, and every site footer`, async () => {
      const page = await Bun.file(file).text();
      const canonical = page.match(/<link rel="canonical" href="([^"]+)"/);
      expect(canonical).not.toBeNull();
      const path = new URL(canonical![1]).pathname;
      // cleanUrls serves the file at its canonical path.
      expect(`site${path}.html`).toBe(file);
      expect(STATIC_PATHS).toContain(path);
      expect(await Bun.file("site/llms.txt").text()).toContain(canonical![1]);

      const footerPages: string[] = [];
      for await (const html of new Bun.Glob("site/**/*.html").scan(".")) {
        const text = await Bun.file(html).text();
        const footer = text.match(
          /<footer class="site-footer">([\s\S]*?)<\/footer>/,
        );
        if (!footer?.[1].includes('class="footer-columns"')) continue;
        footerPages.push(html);
        expect(footer[1], html).toContain(`href="${path}"`);
      }
      expect(footerPages).toContain("site/index.html");
      expect(footerPages).toContain("site/es/index.html");
      expect(footerPages).toContain(file);
    });
  }

  it("lists the published contact channels on the contact page", async () => {
    const page = await Bun.file("site/contact.html").text();
    const security = await Bun.file("site/security.txt").text();
    const email = security.match(/^Contact: mailto:(\S+)$/m)![1];
    for (const href of [
      `mailto:${email}`,
      "https://discord.gg/FrjEYyNvYs",
      "https://github.com/nmamano/isomux/issues",
      "/.well-known/security.txt",
      "https://github.com/nmamano/isomux/blob/main/COMMERCIAL-LICENSE.md",
    ]) {
      expect(page).toContain(`href="${href}"`);
    }
  });

  // The landing page and its Spanish, Catalan and Chinese copies.
  const LANDINGS = [
    "site/index.html",
    "site/es/index.html",
    "site/ca/index.html",
    "site/zh/index.html",
  ];

  it("describes one Organization on the homepage and the about page", async () => {
    const home = jsonLdBlocks(await Bun.file("site/index.html").text());
    const about = jsonLdBlocks(await Bun.file("site/about.html").text());
    const app = home.find((b) => b["@type"] === "SoftwareApplication");
    const org = home.find((b) => b["@type"] === "Organization");
    expect(app).toBeDefined();
    expect(org).toBeDefined();
    const { "@context": context, ...homeOrg } = org!;
    expect(context).toBe("https://schema.org");
    expect(about[0].mainEntity).toEqual(homeOrg);

    expect(org!["@id"]).toBe("https://isomux.com/#organization");
    expect(app!.publisher).toEqual({ "@id": org!["@id"] });
    expect(org!.legalName).toBe("Isomux LLC");

    const contact = await Bun.file("site/contact.html").text();
    const contactUrl = contact.match(
      /<link rel="canonical" href="([^"]+)"/,
    )![1];
    expect(org!.contactPoint).toMatchObject({
      "@type": "ContactPoint",
      email: org!.email,
      url: contactUrl,
    });
    expect(org!.contactPoint.contactType).toBeTruthy();

    // The registered street address is a home address: region and country
    // only.
    expect(org!.address["@type"]).toBe("PostalAddress");
    expect(org!.address.addressCountry).toBe("US");
    expect(org!.address.addressRegion).toBeTruthy();
    expect(Object.keys(org!.address).sort()).toEqual([
      "@type",
      "addressCountry",
      "addressRegion",
    ]);

    for (const file of LANDINGS) {
      const blocks = jsonLdBlocks(await Bun.file(file).text());
      const { "@context": _, ...copy } = blocks.find(
        (b) => b["@type"] === "Organization",
      ) ?? { "@context": null };
      expect(copy, file).toEqual(homeOrg);
      expect(
        blocks.find((b) => b["@type"] === "SoftwareApplication")?.publisher,
        file,
      ).toEqual({ "@id": org!["@id"] });
    }
  });

  it("offers the software and the Hosted plans at the published prices", async () => {
    const hosted = await Bun.file("site/hosted.html").text();
    const plans = [
      ...hosted.matchAll(
        /<h3>(\w+) <span class="price">(\d+) EUR\/month<\/span><\/h3>/g,
      ),
    ].map(([, name, price]) => ({ name, price: Number(price) }));
    expect(plans.length).toBeGreaterThan(0);
    expect(hosted).toContain('id="plans"');

    const about = (await Bun.file("site/about.html").text()).replace(
      /\s+/g,
      " ",
    );
    for (const plan of plans) {
      expect(about).toContain(`${plan.name} ${plan.price} EUR/month`);
    }

    // The software is free only up to the size the license grants.
    const license = await Bun.file("LICENSE").text();
    const limit = license.match(/organization with at most (\d+) people/)![1];

    for (const file of LANDINGS) {
      const app = jsonLdBlocks(await Bun.file(file).text()).find(
        (b) => b["@type"] === "SoftwareApplication",
      )!;
      const offers: Record<string, any>[] = app.offers;
      expect(Array.isArray(offers), file).toBe(true);
      expect(offers.length, file).toBe(plans.length + 1);

      for (const plan of plans) {
        const offer = offers.find((o) => o.name?.includes(plan.name));
        expect(offer, `${file} ${plan.name}`).toBeDefined();
        expect(offer!["@type"]).toBe("Offer");
        expect(Number(offer!.price)).toBe(plan.price);
        expect(offer!.priceCurrency).toBe("EUR");
        expect(offer!.url).toBe("https://isomux.com/hosted#plans");
        expect(offer!.priceSpecification).toMatchObject({
          "@type": "UnitPriceSpecification",
          priceCurrency: "EUR",
          unitCode: "MON",
        });
        expect(Number(offer!.priceSpecification.price)).toBe(plan.price);
      }

      const free = offers.filter((o) => Number(o.price) === 0);
      expect(free.length, file).toBe(1);
      expect(free[0]["@type"]).toBe("Offer");
      expect(free[0].description, file).toContain(limit);
    }
  });

  it("redirects /pricing to the Hosted plans without a permanent redirect", async () => {
    const vercel = JSON.parse(await Bun.file("vercel.json").text());
    expect(
      vercel.redirects.find((r: { source: string }) => r.source === "/pricing"),
    ).toEqual({
      source: "/pricing",
      destination: "/hosted#plans",
      permanent: false,
    });
    expect(await Bun.file("site/llms.txt").text()).toMatch(
      /https:\/\/isomux\.com\/(pricing|hosted#plans)\b/,
    );
  });

  it("publishes an RFC 9727 API catalog for the chat endpoint", async () => {
    const vercel = JSON.parse(await Bun.file("vercel.json").text());
    const rewrites: { source: string; destination: string }[] = vercel.rewrites;
    const catchAll = rewrites.findIndex((r) => r.source === "/:path*");
    expect(catchAll).toBe(rewrites.length - 1);
    // Each rewrite before the catch-all serves a file that exists.
    for (const r of rewrites.slice(0, catchAll)) {
      expect(await Bun.file(`site${r.destination}`).exists(), r.source).toBe(
        true,
      );
    }
    const rewrite = rewrites.find(
      (r) => r.source === "/.well-known/api-catalog",
    );
    expect(rewrite).toBeDefined();

    const headers = vercel.headers.find(
      (h: { source: string }) => h.source === "/.well-known/api-catalog",
    );
    const type = headers?.headers.find(
      (h: { key: string }) => h.key.toLowerCase() === "content-type",
    )?.value;
    expect(type).toBe(
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    );

    const catalog = JSON.parse(
      await Bun.file(`site${rewrite!.destination}`).text(),
    );
    const entry = catalog.linkset.find(
      (e: { anchor: string }) => e.anchor === "https://isomux.com/api/chat",
    );
    expect(entry).toBeDefined();
    expect(await resolves(entry["service-desc"][0].href, vercel)).toBe("file");
    expect(new URL(entry["service-desc"][0].href).pathname).toBe(
      "/openapi.json",
    );
    expect(new URL(entry["service-doc"][0].href).pathname).toBe(
      "/docs/developer-api",
    );
    expect(await resolves(entry["service-doc"][0].href, vercel)).toBe("doc");
  });

  it("points agents at the machine-readable resources from the homepage", async () => {
    const vercel = JSON.parse(await Bun.file("vercel.json").text());
    const root = vercel.headers.find(
      (h: { source: string }) => h.source === "/",
    );
    const link: string = root.headers.find(
      (h: { key: string }) => h.key === "Link",
    )?.value;
    expect(link).toBeTruthy();
    const targets = new Map<string, string>();
    for (const item of link.split(",")) {
      const m = item.trim().match(/^<([^>]+)>\s*;\s*rel="([^"]+)"/);
      expect(m, item).not.toBeNull();
      targets.set(m![2], m![1]);
    }
    expect([...targets.keys()].sort()).toEqual([
      "api-catalog",
      "describedby",
      "service-desc",
      "service-doc",
    ]);
    expect(
      new URL(targets.get("api-catalog")!, "https://isomux.com").pathname,
    ).toBe("/.well-known/api-catalog");
    expect(await resolves(targets.get("api-catalog")!, vercel)).toBe("rewrite");
    expect(await resolves(targets.get("service-desc")!, vercel)).toBe("file");
    expect(await resolves(targets.get("describedby")!, vercel)).toBe("file");
    expect(await resolves(targets.get("service-doc")!, vercel)).toBe("doc");
  });

  it("documents the rate-limit fields on every chat response", async () => {
    const spec = JSON.parse(await Bun.file("site/openapi.json").text());
    const responses = spec.paths["/api/chat"].post.responses;
    for (const [status, response] of Object.entries<any>(responses)) {
      const resolved = response.$ref
        ? spec.components.responses[response.$ref.split("/").at(-1)]
        : response;
      const names = Object.keys(resolved.headers ?? {});
      expect(names, status).toContain("RateLimit");
      expect(names, status).toContain("RateLimit-Policy");
      if (status === "429") expect(names).toContain("Retry-After");
    }
    expect(Object.keys(responses)).toContain("429");
  });

  it("rewrites cross-document Markdown links to canonical docs URLs", () => {
    expect(
      rewriteMarkdownLinks(
        "Read [setup](vps-install.md), [access](./access-and-invites.md#invite-a-member), and [features](features.md).",
      ),
    ).toBe(
      "Read [setup](/docs/vps-install), [access](/docs/access-and-invites#invite-a-member), and [features](/docs).",
    );
  });

  it("returns structured JSON for chat protocol errors", async () => {
    const method = await chat(new Request("https://isomux.com/api/chat"));
    expect(method.status).toBe(405);
    expect((await method.json()).error.code).toBe("method_not_allowed");

    const invalid = await chat(
      new Request("https://isomux.com/api/chat", { method: "POST", body: "{" }),
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("invalid_json");

    const nonObject = await chat(
      new Request("https://isomux.com/api/chat", {
        method: "POST",
        body: "null",
      }),
    );
    expect(nonObject.status).toBe(400);
    expect((await nonObject.json()).error.code).toBe("invalid_request");

    const badMessage = await chat(
      new Request("https://isomux.com/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [null] }),
      }),
    );
    expect(badMessage.status).toBe(400);
    expect((await badMessage.json()).error.code).toBe("invalid_request");

    const empty = await chat(
      new Request("https://isomux.com/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(empty.status).toBe(400);
    expect((await empty.json()).error.code).toBe("invalid_request");
  });
});
