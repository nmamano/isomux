import { describe, expect, it } from "bun:test";
import chat from "./chat.ts";
import notFound from "./not-found.ts";
import middleware, { negotiate } from "../middleware.ts";
import { rewriteMarkdownLinks } from "../scripts/build-docs.ts";

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
      new Request("https://isomux.com/docs/self-hosted", {
        headers: { Accept: "text/markdown" },
      }),
    );
    expect(markdown.headers.get("x-middleware-rewrite")).toBe(
      "https://isomux.com/_agent/docs/self-hosted/index.md",
    );
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("vary")).toBe("Accept, Accept-Encoding");

    const html = middleware(
      new Request("https://isomux.com/docs/self-hosted", {
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

    const chatbot = await Bun.file("site/chatbot.js").text();
    expect(chatbot).toContain("err.error?.message || err.error");

    const vercel = JSON.parse(await Bun.file("vercel.json").text());
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
  });

  it("rewrites cross-document Markdown links to canonical docs URLs", () => {
    expect(
      rewriteMarkdownLinks(
        "Read [setup](vps-install.md), [access](./access-and-invites.md#invites), and [features](features.md).",
      ),
    ).toBe(
      "Read [setup](/docs/vps-install), [access](/docs/access-and-invites#invites), and [features](/docs).",
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
