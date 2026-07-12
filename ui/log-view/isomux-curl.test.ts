import { describe, expect, test } from "bun:test";
import { parseIsomuxCurl, describeIsomuxRoute } from "./isomux-curl.ts";

describe("parseIsomuxCurl", () => {
  test("simple GET task list", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000/tasks");
    expect(req).not.toBeNull();
    expect(req!.method).toBe("GET");
    expect(req!.path).toBe("/tasks");
    expect(req!.action).toBe("List tasks");
    expect(req!.bodyFields).toBeNull();
    expect(req!.pipeTail).toBeNull();
  });

  test("GET with query string", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000/tasks?status=all");
    expect(req!.path).toBe("/tasks?status=all");
    expect(req!.action).toBe("List tasks");
  });

  test("POST create task with JSON body", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/tasks -H 'Content-Type: application/json' -d '{"title":"Fix bug","createdBy":"Isomuxer1","priority":"P1"}'`,
    );
    expect(req!.method).toBe("POST");
    expect(req!.action).toBe("Create task");
    expect(req!.bodyFields).toEqual([
      { key: "title", value: "Fix bug" },
      { key: "createdBy", value: "Isomuxer1" },
      { key: "priority", value: "P1" },
    ]);
    expect(req!.hasAuth).toBe(false);
  });

  test("multi-line continuation (backslash-newline)", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/tasks -H 'Content-Type: application/json' \\\n  -d '{"title":"X","createdBy":"Me"}'`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.bodyFields![0]).toEqual({ key: "title", value: "X" });
  });

  test("send agent message with bearer token env var", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/agents/agent-123-abc/messages -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" -H 'Content-Type: application/json' -d '{"text":"hello there"}'`,
    );
    expect(req!.action).toBe("Send agent message");
    expect(req!.path).toBe("/api/agents/agent-123-abc/messages");
    expect(req!.hasAuth).toBe(true);
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hello there" }]);
  });

  test("claim and done task routes", () => {
    expect(
      parseIsomuxCurl(
        `curl -s -X POST localhost:4000/tasks/28ab9400/claim -H 'Content-Type: application/json' -d '{"assignee":"Isomuxer1"}'`,
      )!.action,
    ).toBe("Claim task");
    expect(
      parseIsomuxCurl(
        `curl -s -X POST localhost:4000/tasks/28ab9400/done -d '{}'`,
      )!.action,
    ).toBe("Complete task");
  });

  test("empty JSON object body yields empty bodyFields", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/agents/a1/diff -H "Authorization: Bearer $T" -d '{}'`,
    );
    expect(req!.action).toBe("Show diff in chat");
    expect(req!.bodyFields).toEqual([]);
    expect(req!.bodyRaw).toBeNull();
  });

  test("-d implies POST", () => {
    const req = parseIsomuxCurl(
      `curl -s localhost:4000/api/memory -d '{"scope":"agent","text":"fact"}'`,
    );
    expect(req!.method).toBe("POST");
    expect(req!.action).toBe("Append memory");
  });

  test("nested JSON values are stringified compactly", () => {
    const req = parseIsomuxCurl(
      `curl -s -X PUT localhost:4000/api/memory -d '{"scope":"room","meta":{"a":1,"b":[2,3]}}'`,
    );
    expect(req!.action).toBe("Replace memory");
    expect(req!.bodyFields).toEqual([
      { key: "scope", value: "room" },
      { key: "meta", value: '{"a":1,"b":[2,3]}' },
    ]);
  });

  test("non-JSON body falls back to bodyRaw", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/tasks -d 'title=hello&x=1'`,
    );
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyRaw).toBe("title=hello&x=1");
  });

  test("body with $VAR inside JSON is not valid JSON, kept raw", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/tasks -d "{\\"title\\": $TITLE}"`,
    );
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyRaw).toBe('{"title": $TITLE}');
  });

  test("pipe tail is captured verbatim", () => {
    const req = parseIsomuxCurl(
      `curl -s localhost:4000/tasks | jq '.[] | .title'`,
    );
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/tasks");
    expect(req!.pipeTail).toBe(`| jq '.[] | .title'`);
  });

  test("pipe into sed redaction", () => {
    const req = parseIsomuxCurl(
      `curl -s 'localhost:4000/api/memory?scope=agent' -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" | sed 's/tok-[a-z0-9]*/REDACTED/g'`,
    );
    expect(req!.action).toBe("Read memory");
    expect(req!.path).toBe("/api/memory?scope=agent");
    expect(req!.pipeTail).toStartWith("| sed");
  });

  test("multi-stage filter pipeline accepted", () => {
    const req = parseIsomuxCurl(
      `curl -s localhost:4000/tasks | jq '.[] | .title' | head -5`,
    );
    expect(req).not.toBeNull();
    expect(req!.pipeTail).toBe(`| jq '.[] | .title' | head -5`);
  });

  test("pipe into python json.tool accepted", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | python3 -m json.tool"),
    ).not.toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | python3 evil.py"),
    ).toBeNull();
  });

  test("rejects pipe tails that aren't pure display filters", () => {
    // A second command hidden after the filter.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | cat; rm -rf /tmp/x"),
    ).toBeNull();
    // Redirection in the tail.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | cat > /tmp/out"),
    ).toBeNull();
    // Command substitution in the tail.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | grep $(cat pattern)"),
    ).toBeNull();
    // Non-filter commands (could have side effects / send data elsewhere).
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | curl example.com"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | xargs rm"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | tee /tmp/out"),
    ).toBeNull();
    // Bare/empty pipe stages.
    expect(parseIsomuxCurl("curl -s localhost:4000/tasks |")).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:4000/tasks | | cat")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks | jq '.' |"),
    ).toBeNull();
    // awk is arbitrary code (system()), not on the allowlist.
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/tasks | awk 'BEGIN { system("touch /tmp/pwn") }'`,
      ),
    ).toBeNull();
  });

  test("rejects pipe tails over the length cap", () => {
    const longTail = `| jq '${"x".repeat(90)}'`;
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/tasks ${longTail}`),
    ).toBeNull();
  });

  // The allowlist is a coarse gate, not a purity proof: allowed commands can
  // still have side effects via their arguments. The safety property is that
  // pipeTail is short (length-capped) and the UI renders it verbatim and
  // untruncated, so the card never conceals what the raw rendering would show.
  test("side-effecting args of allowed filters parse, with verbatim pipeTail", () => {
    const cases = [
      "| sed -e w/tmp/pwn",
      "| sort -o /tmp/pwn",
      "| uniq /dev/stdin /tmp/pwn",
    ];
    for (const tail of cases) {
      const req = parseIsomuxCurl(`curl -s localhost:4000/tasks ${tail}`);
      expect(req).not.toBeNull();
      expect(req!.pipeTail).toBe(tail);
    }
  });

  test("http:// scheme and 127.0.0.1 accepted", () => {
    expect(parseIsomuxCurl("curl http://localhost:4000/tasks")).not.toBeNull();
    expect(parseIsomuxCurl("curl -s 127.0.0.1:4000/tasks")).not.toBeNull();
  });

  test("attached short flag value (-XPOST) and clustered booleans (-sS)", () => {
    const req = parseIsomuxCurl(
      `curl -sS -XPOST localhost:4000/tasks -d '{"title":"t"}'`,
    );
    expect(req!.method).toBe("POST");
  });

  test("--request=POST long form with equals", () => {
    const req = parseIsomuxCurl("curl --request=POST localhost:4000/tasks");
    expect(req!.method).toBe("POST");
  });

  test("DELETE scheduled message", () => {
    const req = parseIsomuxCurl(
      `curl -s -X DELETE localhost:4000/api/agents/agent-1/scheduled-messages/sched-9 -H "Authorization: Bearer $T"`,
    );
    expect(req!.method).toBe("DELETE");
    expect(req!.action).toBe("Cancel scheduled message");
  });

  test("unknown isomux route still parses, without action label", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000/api/office/settings");
    expect(req).not.toBeNull();
    expect(req!.action).toBeNull();
    expect(req!.method).toBe("GET");
  });

  test("path containing $VAR is kept literally", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST "localhost:4000/api/agents/$RECEIVER/messages" -d '{"text":"hi"}'`,
    );
    expect(req!.path).toBe("/api/agents/$RECEIVER/messages");
    // Unknown segment value still matches the wildcard route.
    expect(req!.action).toBe("Send agent message");
  });

  test("custom extra port accepted when passed", () => {
    expect(parseIsomuxCurl("curl -s localhost:8080/tasks")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:8080/tasks", ["4000", "8080"]),
    ).not.toBeNull();
  });

  // --- rejections: must degrade to raw rendering ---

  test("rejects non-isomux hosts and ports", () => {
    expect(parseIsomuxCurl("curl -s https://example.com/api")).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:5599/api/state")).toBeNull();
    expect(parseIsomuxCurl("curl -s auntie:4000/tasks")).toBeNull();
  });

  test("rejects non-curl commands", () => {
    expect(parseIsomuxCurl("ls -la")).toBeNull();
    expect(parseIsomuxCurl("echo curl localhost:4000/tasks")).toBeNull();
    expect(parseIsomuxCurl("")).toBeNull();
  });

  test("rejects compound commands and redirections", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks && echo done"),
    ).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:4000/tasks; ls")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks > out.json"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks 2>/dev/null"),
    ).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:4000/tasks || true")).toBeNull();
  });

  test("rejects command substitution", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks/$(cat id)/done"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks/`cat id`/done"),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s -d "{\\"x\\": \\"$(whoami)\\"}" localhost:4000/tasks`,
      ),
    ).toBeNull();
  });

  test("rejects options whose semantics the card would conceal", () => {
    // File write.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks -o /tmp/tasks.json"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks --output /tmp/t.json"),
    ).toBeNull();
    // Upload: changes method and supplies a body the card wouldn't show.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/memory -T /tmp/payload"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/memory --upload-file /tmp/p"),
    ).toBeNull();
    // Credentials.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks -u admin:secret"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks --user admin:secret"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks -b session=abc"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks --cookie s=1"),
    ).toBeNull();
    // Extra request headers via dedicated options.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks -A myagent"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/tasks -e http://x"),
    ).toBeNull();
    // write-out: %output{file} (curl >= 8.3.0) writes a file, so -w is out.
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/tasks -w '%output{/tmp/pwn}x'`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/tasks --write-out '%{http_code}'`,
      ),
    ).toBeNull();
  });

  test("only Content-Type and Authorization headers are admitted", () => {
    // Generic -H must not bypass the rejected credential/header flags.
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/tasks -H 'Cookie: session=abc'`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/tasks --header 'Cookie: session=abc'`,
      ),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/tasks -H 'User-Agent: myagent'`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/tasks -H 'X-Custom: 1'`),
    ).toBeNull();
    // The two transcript-standard headers still pass (case-insensitive).
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/tasks -H 'content-type: application/json' --header "AUTHORIZATION: Bearer $T"`,
      ),
    ).not.toBeNull();
  });

  test("transport-neutral options remain accepted", () => {
    expect(
      parseIsomuxCurl(
        "curl -s -m 5 --retry 2 --connect-timeout 3 localhost:4000/tasks",
      ),
    ).not.toBeNull();
  });

  test("rejects unknown flags and multiple URLs", () => {
    expect(
      parseIsomuxCurl("curl --weird-flag localhost:4000/tasks"),
    ).toBeNull();
    expect(parseIsomuxCurl("curl -Z localhost:4000/tasks")).toBeNull();
    expect(
      parseIsomuxCurl("curl localhost:4000/a localhost:4000/b"),
    ).toBeNull();
  });

  test("rejects unescaped multi-line commands", () => {
    expect(parseIsomuxCurl("curl -s localhost:4000/tasks\nls")).toBeNull();
  });

  test("rejects unterminated quotes", () => {
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/tasks -d '{"title":`),
    ).toBeNull();
  });

  test("bare loopback root path defaults to /", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000");
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/");
    expect(req!.action).toBeNull();
  });
});

describe("describeIsomuxRoute", () => {
  test("matches with query strings and trailing slashes", () => {
    expect(describeIsomuxRoute("GET", "/tasks?status=all")).toBe("List tasks");
    expect(describeIsomuxRoute("GET", "/tasks/")).toBe("List tasks");
    expect(describeIsomuxRoute("GET", "/api/tasks")).toBe("List tasks");
  });

  test("wildcards match exactly one segment", () => {
    expect(describeIsomuxRoute("POST", "/tasks/abc/claim")).toBe("Claim task");
    expect(describeIsomuxRoute("POST", "/tasks/a/b/claim")).toBeNull();
  });

  test("method must match", () => {
    expect(describeIsomuxRoute("DELETE", "/api/memory")).toBeNull();
  });
});
