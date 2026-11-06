// The mail for each update of a critical issue: one Resend call to every
// contact with the whole update and the issue link, replies to llc@, and a
// failure that comes back as a value and never prints the private link.

import { describe, expect, test } from "bun:test";
import type { PostedUpdate } from "../../incidents";
import { sendIncidentUpdateMail } from "./incident-mail.server";

const ISSUE_URL =
  "https://cloud.isomux.com/status/cust-1.Zm9vYmFyYmF6cXV4c2VjcmV0bWFjdmFsdWU/1";
const TOKEN_MAC = "Zm9vYmFyYmF6cXV4c2VjcmV0bWFjdmFsdWU";

const POSTED: PostedUpdate = {
  incidentId: "inc-1",
  customerId: "cust-1",
  customerLabel: "Acme",
  linkGeneration: 1,
  n: 1,
  title: "Office down",
  kind: "critical",
  timeZone: "America/Los_Angeles",
  contacts: ["ops@acme.example", "cto@acme.example"],
  update: {
    n: 3,
    postedAt: Date.parse("2027-06-10T00:00:00Z"),
    author: "engineer",
    found: "The sync worker crashes on start",
    doingNow: "Rolling back the last release",
    estimateAt: Date.parse("2027-06-10T01:30:00Z"),
    final: false,
  },
};

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function fakeFetch(answer: () => Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : input.toString(),
      headers: new Headers(init?.headers),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return answer();
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Everything the module prints while `run` runs. */
async function printed(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  const keep = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) =>
          a instanceof Error
            ? `${a.message} ${a.stack}`
            : (JSON.stringify(a) ?? String(a)),
        )
        .join(" "),
    );
  };
  console.error = keep;
  console.warn = keep;
  console.log = keep;
  try {
    await run();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

describe("sendIncidentUpdateMail", () => {
  test("no Resend key: not_configured, and nothing is sent", async () => {
    const fake = fakeFetch(async () => new Response("{}"));
    expect(
      await sendIncidentUpdateMail(POSTED, ISSUE_URL, {
        apiKey: undefined,
        fetch: fake.fetch,
      }),
    ).toBe("not_configured");
    expect(fake.calls).toHaveLength(0);
  });

  test("one call to every contact, with the whole update and the issue link", async () => {
    const fake = fakeFetch(async () => new Response('{"id":"m1"}'));
    expect(
      await sendIncidentUpdateMail(POSTED, ISSUE_URL, {
        apiKey: "re_test_key",
        fetch: fake.fetch,
      }),
    ).toBe("sent");
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.headers.get("authorization")).toBe("Bearer re_test_key");
    expect(call.body.to).toEqual(["ops@acme.example", "cto@acme.example"]);
    expect(call.body.reply_to).toBe("llc@isomux.com");
    expect(String(call.body.from)).toContain("@isomux.com");
    expect(String(call.body.subject)).toContain("Office down");
    // The text and the html (whichever the mail carries) hold the update and
    // the link.
    const content = [call.body.text, call.body.html]
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    for (const part of [
      POSTED.update.found,
      POSTED.update.doingNow,
      ISSUE_URL,
    ]) {
      expect({ part, inMail: content.includes(part) }).toEqual({
        part,
        inMail: true,
      });
    }
  });

  test("a refused or failed send is failed, never a rejection, and prints no link", async () => {
    const answers: [string, () => Promise<Response>][] = [
      // Resend's error bodies can quote the request back.
      [
        "500",
        async () =>
          new Response(
            `{"message":"bad request: ${ISSUE_URL} ops@acme.example"}`,
            {
              status: 500,
            },
          ),
      ],
      [
        "network",
        async () => {
          throw new Error("connect ECONNREFUSED");
        },
      ],
    ];
    for (const [name, answer] of answers) {
      const fake = fakeFetch(answer);
      let outcome: unknown;
      const out = await printed(async () => {
        outcome = await sendIncidentUpdateMail(POSTED, ISSUE_URL, {
          apiKey: "re_test_key",
          fetch: fake.fetch,
        });
      });
      expect({ name, outcome }).toEqual({ name, outcome: "failed" });
      expect({ name, linkPrinted: out.includes(TOKEN_MAC) }).toEqual({
        name,
        linkPrinted: false,
      });
      expect({
        name,
        contactPrinted: out.includes("ops@acme.example"),
      }).toEqual({
        name,
        contactPrinted: false,
      });
    }
  });
});
