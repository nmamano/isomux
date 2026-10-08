// The first-owner claim, the one step that differs between hosting paths.
// Every path claims through this helper, so a change to how a new office is
// claimed is adapted here and nowhere else.
//
//   setup-link  `bun run dev`: the setup link the office prints, with the key
//               in its fragment.
//   setup-key   the container image: the key in ISOMUX_SETUP_KEY, entered on
//               the setup listener's form.
//   invite      deploy/install.sh: the owner invite link it saves, after it
//               claimed the office itself.
import { REQUEST_TIMEOUT_MS, request } from "./http.ts";

export type ClaimMethod =
  | { kind: "setup-link"; name: string; url: string }
  | { kind: "setup-key"; name: string; key: string }
  | { kind: "invite"; url: string };

const SESSION_COOKIES = ["__Host-isomux_session", "isomux_session"];

// The `name=value` pair of the office session cookie, or null.
export function sessionCookie(setCookies: string[]): string | null {
  for (const name of SESSION_COOKIES) {
    for (const line of setCookies) {
      const pair = line.split(";", 1)[0]!.trim();
      if (pair.startsWith(`${name}=`) && pair.length > name.length + 1)
        return pair;
    }
  }
  return null;
}

// The URL the client polls before it claims: the container answers only its
// setup listener until an owner exists; the other paths serve the office.
export function preClaimProbe(kind: ClaimMethod["kind"]): string {
  return kind === "setup-key" ? "/health" : "/readyz";
}

// The setup key in a printed setup link's fragment.
export function setupLinkKey(url: string): string {
  const key = new URLSearchParams(new URL(url).hash.slice(1)).get("key");
  if (!key) throw new Error("the setup link carries no key");
  return key;
}

// Claims the office and returns the Cookie header value for the owner session.
export async function claimOwner(
  base: string,
  origin: string,
  method: ClaimMethod,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<string> {
  const post = (path: string, form: Record<string, string>) =>
    request(
      `${base}${path}`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: origin,
        },
        body: new URLSearchParams(form),
      },
      `POST ${path}`,
      timeoutMs,
    );
  let response: Response;
  // The office answers a claim with a redirect into the office; the
  // container's setup listener answers with a page that waits for the office.
  let expected: number;
  if (method.kind === "setup-link") {
    response = await post("/auth/claim", {
      name: method.name,
      key: setupLinkKey(method.url),
    });
    expected = 302;
  } else if (method.kind === "setup-key") {
    response = await post("/auth/claim", {
      name: method.name,
      key: method.key,
    });
    expected = 200;
  } else {
    const token = new URL(method.url).pathname.match(/^\/i\/([^/]+)$/)?.[1];
    if (!token) throw new Error("the saved invite link has no /i/ token");
    // Opening the link shows a page; the form on it redeems the invite.
    response = await post("/auth/accept", { token });
    expected = 302;
  }
  if (response.status !== expected)
    throw new Error(
      `${method.kind} claim answered HTTP ${response.status}, expected ${expected}: ${(await response.text()).slice(0, 300)}`,
    );
  const cookie = sessionCookie(response.headers.getSetCookie());
  if (!cookie)
    throw new Error(`${method.kind} claim set no office session cookie`);
  return cookie;
}
