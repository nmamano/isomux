// The server administrator key on the signup form.
//
// The browser generates the key pair. Only the public line goes to the
// server; the private key stays on the customer's machine. The form shows it
// on request and saves it to a file, and neither path leaves it in the request
// or in the page.
//
// happy-dom is registered in this file's body and removed when it ends: the
// rest of the suite shares this process and needs Bun's own globals. Every
// module that touches the DOM is loaded after registration.

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://storefront.example.com/signup" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom has no secure-context flag; the form generates a key only in one.
Object.defineProperty(window, "isSecureContext", {
  value: true,
  configurable: true,
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SignupForm } = await import("./signup-form");
const { captureSignupSource, SIGNUP_SOURCE_TTL_MS } =
  await import("../lib/signup-source");

const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch;
  await GlobalRegistrator.unregister();
});

interface Post {
  url: string;
  method: string;
  headers: [string, string][];
  body: FormData;
}
let posts: Post[] = [];

// Every request is refused, so the form stays on the page.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  posts.push({
    url:
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    method: init?.method ?? "GET",
    headers: [...new Headers(init?.headers).entries()],
    body: init?.body as FormData,
  });
  return Response.json({ ok: false, reason: "refused" }, { status: 400 });
}) as typeof fetch;

let container: HTMLElement;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  posts = [];
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Renders the form and waits for the browser to generate the key. */
async function renderWithKey(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(SignupForm, {
        language: "en",
        domain: "test.isomux.app",
        initialName: "acme",
        plans: [
          {
            id: "office",
            label: "Entry",
            specification: "4 vCPU",
            customerPrice: null,
          },
        ],
      }),
    );
  });
  for (let i = 0; i < 100 && button(".key-reveal").disabled; i++) {
    await settle();
  }
  // The enabling condition: a key exists, so the key buttons are live.
  expect(button(".key-reveal").disabled).toBe(false);
}

function button(selector: string): HTMLButtonElement {
  return container.querySelector(selector) as HTMLButtonElement;
}

function privateKeyBox(): HTMLTextAreaElement {
  return container.querySelector(
    '[data-testid="server-administrator-private-key"]',
  ) as HTMLTextAreaElement;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle();
}

async function reveal(): Promise<string> {
  await click(button(".key-reveal"));
  return privateKeyBox().value;
}

/** The base64 body lines of an OpenSSH private key, at full width. */
function bodyLines(privateKey: string): string[] {
  return privateKey
    .split("\n")
    .filter((line) => line.length === 70 && !line.startsWith("-----"));
}

test("the private key is shown only on request", async () => {
  await renderWithKey();
  expect(privateKeyBox().value).toBe("");
  const shown = await reveal();
  expect(shown).toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(bodyLines(shown).length).toBeGreaterThan(0);
});

test("submit sends the public line and no part of the private key", async () => {
  await renderWithKey();
  // Revealed is the worst case: the page then holds the private key in a field.
  const privateKey = await reveal();
  const lines = bodyLines(privateKey);
  expect(lines.length).toBeGreaterThan(0);
  await click(container.querySelector(".key-confirm input") as HTMLElement);
  await click(button('[data-testid="signup-submit"]'));

  expect(posts.length).toBe(1);
  const [post] = posts;
  expect(post.url).toBe("/api/signup");
  expect(post.method).toBe("POST");
  expect([...post.body.keys()].sort()).toEqual([
    "couponId",
    "customerSshKey",
    "officeName",
    "plan",
    "signupIntent",
  ]);
  const publicLine = post.body.get("customerSshKey");
  if (typeof publicLine !== "string") throw new Error("no public key line");
  expect(publicLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
  // An Ed25519 public blob: the type string and the 32-byte key, each with a
  // 4-byte length.
  expect(atob(publicLine.slice("ssh-ed25519 ".length)).length).toBe(
    4 + "ssh-ed25519".length + 4 + 32,
  );

  const sent = [
    post.url,
    ...post.headers.flat(),
    ...[...post.body.values()].map(String),
  ];
  for (const value of sent) {
    expect(value).not.toContain("PRIVATE KEY");
    for (const line of lines) expect(value).not.toContain(line);
  }
});

test("download hands the private key to a file and leaves nothing behind", async () => {
  const url = "blob:https://storefront.example.com/key";
  const created = spyOn(URL, "createObjectURL").mockImplementation(() => url);
  const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    await renderWithKey();
    const privateKey = await reveal();

    await click(button(".key-download"));

    expect(created.mock.calls.length).toBe(1);
    expect(await (created.mock.calls[0][0] as Blob).text()).toBe(privateKey);
    expect(document.querySelector("a[download]")?.tagName ?? null).toBeNull();
    expect(revoked.mock.calls).toEqual([[url]]);
  } finally {
    created.mockRestore();
    revoked.mockRestore();
  }
});

// The signup source (task 8a12ba81): a page of this app stored it when the
// visitor arrived, and the submit posts it with the reservation. An expired one
// is not posted: the 30-day window is the promise on the privacy page.
async function submitWithStoredSource(capturedAt: number): Promise<Post> {
  captureSignupSource(
    "https://storefront.example.com/?utm_source=newsletter&utm_campaign=launch-week" +
      "&ref_host=t.co&landing_path=%2Fblog%2Fhosted",
    "",
    localStorage,
    capturedAt,
  );
  try {
    await renderWithKey();
    await click(container.querySelector(".key-confirm input") as HTMLElement);
    await click(button('[data-testid="signup-submit"]'));
  } finally {
    localStorage.clear();
  }
  expect(posts.length).toBe(1);
  return posts[0];
}

test("submit posts the stored signup source", async () => {
  const post = await submitWithStoredSource(Date.now());
  expect(
    ["utm_source", "utm_campaign", "ref_host", "landing_path"].map((key) =>
      post.body.get(key),
    ),
  ).toEqual(["newsletter", "launch-week", "t.co", "/blog/hosted"]);
});

test("submit posts no expired signup source", async () => {
  const post = await submitWithStoredSource(
    Date.now() - SIGNUP_SOURCE_TTL_MS - 60_000,
  );
  // The enabling condition: the form did post.
  expect(post.body.get("officeName")).toBe("acme");
  expect(
    ["utm_source", "utm_campaign", "ref_host", "landing_path"].filter((key) =>
      post.body.has(key),
    ),
  ).toEqual([]);
});
