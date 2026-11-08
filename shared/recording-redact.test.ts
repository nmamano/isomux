// Recording mode's text rules (task 6e08239a): compileRedactor and the word
// list check, as pure functions. The DOM layer (ui/recording-mode.ts) and the
// CodeMirror extension only apply what this returns, so the rules are pinned
// here once.
//
// Pins: every automatic rule hides what it names; the near misses stay as
// they are (a false hit garbles the recording); a pattern beats a member word
// at the same text; one pass, so a stand-in is never scanned again;
// keepLength keeps the text's length; built-in stand-ins are a fixed point.
//
// Task 1a5c9478 adds member names ("Member N") and file paths ("…/" and the
// last segment, "~" for a home folder), both pinned as the agreed design
// writes them.
//
// The built-in stand-ins are the reserved names (RFC 2606, RFC 5737) the
// agreed design names, not product copy. The phone and secret stand-ins are
// not pinned: only that the original is gone.

import { describe, expect, it } from "bun:test";
import {
  compileRedactor,
  defaultRecordingWords,
  MAX_RECORDING_WORD_CHARS,
  MAX_RECORDING_WORDS,
  recordingWordsProblem,
  type RecordingRules,
  type RecordingWord,
  type RecordingWordsProblem,
} from "./recording-redact.ts";

const RULES: RecordingRules = {
  officeHosts: ["office.nilmamano.com"],
  otherOffices: [
    { url: "https://hq.acmeoffice.org", name: "Acme HQ" },
    { url: "http://lab.zentry.io:4000", name: "Zentry Lab" },
  ],
  words: [],
};

const redactWith = (rules: Partial<RecordingRules>) =>
  compileRedactor({ ...RULES, ...rules });

// Lazy, so a throwing compile fails each test on its own.
const r = (text: string, opts?: { keepLength?: boolean }) =>
  redactWith({})(text, opts);

describe("recording mode: automatic rules", () => {
  it("replaces this office's host, with or without scheme, port or path, and keeps an app's label", () => {
    expect(r("open office.nilmamano.com now")).toBe(
      "open office.example.com now",
    );
    expect(r("https://office.nilmamano.com/inbox/asks?x=1")).toBe(
      "https://office.example.com/inbox/asks?x=1",
    );
    expect(r("loop.office.nilmamano.com/x")).toBe("loop.office.example.com/x");
    // The port may stay or go; the host must not stay.
    const withPort = r("http://office.nilmamano.com:4000/");
    expect(withPort).not.toContain("nilmamano");
    expect(withPort).toContain("office.example.com");
  });

  it("covers every office host it is given, a bare tailnet name included", () => {
    const two = redactWith({
      officeHosts: ["auntie-2:4000", "office.nilmamano.com"],
    });
    const out = two("http://auntie-2:4000/ and office.nilmamano.com");
    expect(out).not.toContain("auntie-2");
    expect(out).not.toContain("nilmamano");
  });

  // A loopback office (a self-hoster on their laptop) reveals nothing, and
  // "localhost" is in every agent's output: replacing it garbles the scene.
  it("leaves a loopback office host alone", () => {
    const local = redactWith({
      officeHosts: ["localhost:4000", "127.0.0.1:4000"],
    });
    for (const text of [
      "curl localhost:4000/agents",
      "http://127.0.0.1:4000/x",
    ])
      expect(local(text)).toBe(text);
  });

  it("numbers other offices from 2 in the order given: host, subdomains and name", () => {
    expect(r("ride to https://hq.acmeoffice.org/room")).toBe(
      "ride to https://office-2.example.com/room",
    );
    expect(r("app.hq.acmeoffice.org")).toBe("app.office-2.example.com");
    expect(r("Acme HQ and Zentry Lab")).toBe("Office 2 and Office 3");
    const lab = r("http://lab.zentry.io:4000/x");
    expect(lab).not.toContain("zentry");
    expect(lab).toContain("office-3.example.com");
  });

  it("counts the same office twice once", () => {
    const twice = redactWith({
      otherOffices: [
        { url: "https://hq.acmeoffice.org", name: "Acme HQ" },
        { url: "https://hq.acmeoffice.org", name: "Acme HQ" },
        { url: "http://lab.zentry.io:4000", name: "Zentry Lab" },
      ],
    });
    expect(twice("Zentry Lab")).toBe("Office 3");
  });

  it("takes an office with no name by its host only", () => {
    const nameless = redactWith({
      otherOffices: [{ url: "https://hq.acmeoffice.org", name: null }],
    });
    expect(nameless("hq.acmeoffice.org")).toBe("office-2.example.com");
  });

  it("replaces emails, phone numbers, IPv4 addresses, tailnet names and secret shapes", () => {
    expect(r("mail bob.smith+x@corp-mail.io today")).toBe(
      "mail name@example.com today",
    );
    expect(r("ping 100.101.102.103 and 10.0.0.5:4000")).toBe(
      "ping 192.0.2.1 and 192.0.2.1:4000",
    );
    expect(r("http://auntie-2.tail1a2b.ts.net:4000/x")).toBe(
      "http://host.example.net:4000/x",
    );
    for (const [text, secret] of [
      ["call +1 415 555 2671 now", "415 555 2671"],
      ["call +44 20 7946 0958 now", "20 7946 0958"],
      ["call (415) 555-2671 now", "555-2671"],
      ["call 415-555-2671 now", "555-2671"],
      ["key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "AbCdEfGhIjKlMnOpQrStUvWx"],
      ["ghp_" + "a".repeat(36), "a".repeat(36)],
      ["API_KEY=abcdefghijklmnop1234", "abcdefghijklmnop1234"],
      ["Password: Qwertyuiop12345678", "Qwertyuiop12345678"],
    ]) {
      const out = r(text);
      expect({ text, leaks: out.includes(secret) }).toEqual({
        text,
        leaks: false,
      });
    }
  });

  it("leaves loopback and the any-address as they are", () => {
    for (const text of ["127.0.0.1", "listen on 0.0.0.0:4000"])
      expect(r(text)).toBe(text);
  });

  // A false hit garbles the recording and teaches the member to turn the
  // mode off. Each line here looks like one of the patterns and is not.
  it("leaves the near misses as they are", () => {
    for (const text of [
      "v1.2.3",
      "1.2.3",
      "v1.2.3.4",
      "Chrome 120.0.6099.109",
      "1.2.3+20261106",
      "+1234 -56",
      "2026-11-06",
      "2026-11-06T12:30:45Z",
      "12:30:45",
      "3m 20s",
      "took 1234567 ms",
      "1,234,567 tokens",
      "task 6e08239a",
      "57dc3caf71ffb1c14d64a869e68dd406e880236f",
      "localhost:4000",
      "port :4000",
      "10.0.0.256",
      "999.1.1.1",
      "1.2.3.4.5",
      "a@b",
      "sk-short",
      "token: abc",
    ]) {
      const out = r(text);
      expect({ text, out }).toEqual({ text, out: text });
    }
  });
});

describe("recording mode: member words", () => {
  const words = (list: RecordingWord[]) => redactWith({ words: list });

  it("matches case-insensitively and as a whole word, and writes the stand-in as given", () => {
    const w = words([{ word: "Acme", standIn: "Client" }]);
    expect(w("ACME acme Acme")).toBe("Client Client Client");
    expect(w("Acme's deal")).toBe("Client's deal");
    expect(w("Acmeville and preAcme")).toBe("Acmeville and preAcme");
  });

  it("matches a word that ends in punctuation or holds regex characters", () => {
    const w = words([
      { word: "Acme Corp.", standIn: "Client" },
      { word: "C++", standIn: "Lang" },
      { word: "A.B", standIn: "Proj" },
    ]);
    expect(w("Acme Corp. signed")).toBe("Client signed");
    expect(w("C++ code")).toBe("Lang code");
    expect(w("A.B and AxB")).toBe("Proj and AxB");
  });

  it("takes the longer word where two start at the same place", () => {
    const w = words([
      { word: "Acme", standIn: "Client" },
      { word: "Acme Corp", standIn: "BigCo" },
    ]);
    expect(w("Acme Corp and Acme")).toBe("BigCo and Client");
  });

  it("lets a pattern win over a member word inside it", () => {
    const w = words([
      { word: "acme", standIn: "Client" },
      { word: "nilmamano", standIn: "Nobody" },
    ]);
    expect(w("bob@acme.com")).toBe("name@example.com");
    expect(w("office.nilmamano.com")).toBe("office.example.com");
  });

  // One pass: a stand-in is written, never scanned again. The chain list is
  // one recordingWordsProblem refuses; the redactor still must not follow it.
  it("never scans a stand-in again", () => {
    const w = words([
      { word: "Acme", standIn: "Bolt" },
      { word: "Bolt", standIn: "Crux" },
    ]);
    expect(w("Acme Bolt")).toBe("Bolt Crux");
  });

  it("with no rules, still applies the patterns and leaves plain text alone", () => {
    const bare = compileRedactor({
      officeHosts: [],
      otherOffices: [],
      words: [],
    });
    expect(bare("hello world")).toBe("hello world");
    expect(bare("bob@acme.com")).toBe("name@example.com");
  });
});

describe("recording mode: keepLength and the fixed point", () => {
  const w = (text: string, opts?: { keepLength?: boolean }) =>
    redactWith({ words: [{ word: "IBM", standIn: "Client" }] })(text, opts);
  const MIXED =
    "IBM: bob@acme.com at office.nilmamano.com, ip 10.0.0.5, Acme HQ, " +
    "call (415) 555-2671, ghp_" +
    "a".repeat(36) +
    ", auntie-2.tail1a2b.ts.net";

  it("keeps the text's length: each stand-in padded or cut to its match", () => {
    const out = w(MIXED, { keepLength: true });
    expect(out.length).toBe(MIXED.length);
    for (const secret of [
      "IBM",
      "acme",
      "nilmamano",
      "10.0.0.5",
      "Acme HQ",
      "555-2671",
      "tail1a2b",
    ])
      expect({ secret, leaks: out.includes(secret) }).toEqual({
        secret,
        leaks: false,
      });
    // A long stand-in is cut, not spilled into the next column.
    expect(w("IBM|", { keepLength: true })).toBe("Cli|");
  });

  it("is a fixed point for every built-in stand-in, with and without keepLength", () => {
    const once = r(MIXED);
    expect(r(once)).toBe(once);
    const kept = r(MIXED, { keepLength: true });
    expect(r(kept, { keepLength: true })).toBe(kept);
  });
});

// Members (task 1a5c9478): each name is "Member N", N its place in the
// list the store gives (office order). Case-sensitive, so a member named
// "Nil" leaves code's "nil" alone; whole word like a member word.
describe("recording mode: member names", () => {
  const m = (members: string[] | undefined, text: string) =>
    redactWith({ members })(text);
  const THREE = ["Nil", "Ana Lee", "Bo"];

  it("numbers each member by their place in the list, the same in every text", () => {
    expect(m(THREE, "Nil and Ana Lee met Bo")).toBe(
      "Member 1 and Member 2 met Member 3",
    );
    expect(m(THREE, "Bo asked Nil")).toBe("Member 3 asked Member 1");
    expect(m(THREE, "Nil's room (Bo)")).toBe("Member 1's room (Member 3)");
  });

  it("matches whole words only, with the case as written", () => {
    for (const text of [
      "if x == nil return",
      "NIL",
      "ana lee",
      "Nilson and Bob and Bolt",
      "AnaLee",
    ])
      expect({ text, out: m(THREE, text) }).toEqual({ text, out: text });
  });

  it("takes the longer name where two start at the same place", () => {
    expect(m(["Ana", "Ana Lee"], "Ana Lee and Ana")).toBe(
      "Member 2 and Member 1",
    );
  });

  it("is off with no list or an empty one", () => {
    expect(m(undefined, "Nil and Bo")).toBe("Nil and Bo");
    expect(m([], "Nil and Bo")).toBe("Nil and Bo");
  });

  it("lets a pattern win over a member name inside it", () => {
    expect(m(THREE, "mail Nil@corp-mail.io")).toBe("mail name@example.com");
  });

  it("is a fixed point", () => {
    const once = m(THREE, "Nil, Ana Lee and Bo");
    expect(m(THREE, once)).toBe(once);
  });
});

// Paths (task 1a5c9478): "…/" and the last segment; a path that ends at a
// home folder is "~". URL paths and relative paths stay.
describe("recording mode: file paths", () => {
  const p = (text: string, opts?: { keepLength?: boolean }) =>
    redactWith({ paths: true, members: ["Nil"] })(text, opts);

  it("keeps only the last segment of an absolute, home or Windows path", () => {
    const cases: [string, string][] = [
      ["open /home/nil/nil/isomux/ui/App.tsx now", "open …/App.tsx now"],
      ["cwd: /home/nil/nil/isomux", "cwd: …/isomux"],
      ["/var/log/syslog", "…/syslog"],
      ["cd ~/nil/isomux", "cd …/isomux"],
      ["C:\\work\\proj\\App.tsx", "…\\App.tsx"],
      ["C:/work/proj/x.ts", "…/x.ts"],
      ["GET /api/tasks", "GET …/tasks"],
      ["file:///home/nil/docs/a.pdf", "file://…/a.pdf"],
      ["/srv/app/", "…/app/"],
    ];
    for (const [text, want] of cases)
      expect({ text, out: p(text) }).toEqual({ text, out: want });
  });

  it("shows a path that ends at a home folder as ~", () => {
    for (const text of [
      "/home/nil",
      "/home/nil/",
      "/Users/ana",
      "/Users/ana/",
      "C:\\Users\\ana",
      // Windows paths are caseless, and tools print them either way.
      "c:\\users\\ana",
      "C:\\USERS\\ana\\",
    ])
      expect({ text, out: p(text) }).toEqual({ text, out: "~" });
    expect(p("cwd /home/nil, ok")).toBe("cwd ~, ok");
  });

  it("finds a path wherever prose or a command puts it, and leaves the punctuation around it", () => {
    const cases: [string, string][] = [
      ['"/srv/a/b"', '"…/b"'],
      ["'/srv/a/b'", "'…/b'"],
      ["`/srv/a/b`", "`…/b`"],
      ["[x](/srv/a/b.md)", "[x](…/b.md)"],
      ["--cwd=/home/nil/proj", "--cwd=…/proj"],
      ["see /srv/a/x.ts.", "see …/x.ts."],
      ["/srv/a/b, /srv/c/d; done", "…/b, …/d; done"],
      ["in /srv/a/b: yes", "in …/b: yes"],
      ["is it /srv/a/b?", "is it …/b?"],
      ["at /srv/a/x.ts:12:5", "at …/x.ts:12:5"],
      ["at /srv/a/x.ts:12:5.", "at …/x.ts:12:5."],
    ];
    for (const [text, want] of cases)
      expect({ text, out: p(text) }).toEqual({ text, out: want });
  });

  // The path match starts before what it holds, so the kept segment must go
  // through the other rules or the stand-in itself shows the secret.
  it("hides a host, an email, an address or a member name in the kept segment", () => {
    expect(p("/etc/nginx/office.nilmamano.com")).toBe("…/office.example.com");
    expect(p("/srv/mail/bob@corp-mail.io")).toBe("…/name@example.com");
    expect(p("/srv/ips/10.0.0.5")).toBe("…/192.0.2.1");
    expect(p("/home/x/notes/Nil-notes.md")).toBe("…/Member 1-notes.md");
  });

  // A false hit garbles the recording: URL paths, relative paths, dates,
  // fractions and a single segment are not file paths to hide.
  it("leaves URL paths, relative paths and other slashes alone", () => {
    for (const text of [
      "http://localhost:4000/api/x",
      "localhost:4000/api/tasks",
      "ui/App.tsx",
      "../shared/x.ts",
      "./a/b",
      "a/b/c",
      "and/or",
      "2026/11/08",
      "x / y / z",
      "/tmp",
      "cd ~ now",
      "</div>",
      "// a comment",
    ])
      expect({ text, out: p(text) }).toEqual({ text, out: text });
    // The host gets its stand-in; the path after it stays.
    expect(p("https://hq.acmeoffice.org/a/b")).toBe(
      "https://office-2.example.com/a/b",
    );
  });

  it("is off unless asked for", () => {
    const text = "/home/nil/nil/isomux and ~/x/y";
    expect(redactWith({})(text)).toBe(text);
    expect(redactWith({ paths: false })(text)).toBe(text);
  });

  it("keeps the text's length, and gives the editor the same spans", () => {
    const text = "a /home/nil/nil/App.tsx b /home/nil c Nil d";
    const out = p(text, { keepLength: true });
    expect(out.length).toBe(text.length);
    expect(out).not.toContain("home");
    expect(out).not.toContain("nil");
    expect(out).not.toContain("Nil");
    expect(out).toContain("App.tsx");

    const spans = redactWith({ paths: true }).spans!(
      "x /srv/a/b.ts. and /etc/h/office.nilmamano.com",
    );
    expect(spans).toEqual([
      { from: 2, to: 13, standIn: "…/b.ts" },
      { from: 19, to: 46, standIn: "…/office.example.com" },
    ]);
  });

  it("is a fixed point", () => {
    const text =
      "/home/nil/nil/App.tsx, ~/a/b, C:\\Users\\ana, file:///srv/x/y and /home/nil";
    const once = p(text);
    expect(p(once)).toBe(once);
  });
});

describe("recording mode: the word list check", () => {
  const row = (word: string, standIn: string): RecordingWord => ({
    word,
    standIn,
  });

  it("accepts an empty list and a plain one, the limits included", () => {
    expect(recordingWordsProblem([])).toBe(null);
    expect(
      recordingWordsProblem([row("Acme", "Client"), row("Jo", "Sam")]),
    ).toBe(null);
    const full = Array.from({ length: MAX_RECORDING_WORDS }, (_, i) =>
      row(`word${i}`, `stand${i}`),
    );
    expect(recordingWordsProblem(full)).toBe(null);
    const long = "x".repeat(MAX_RECORDING_WORD_CHARS);
    expect(
      recordingWordsProblem([row(long, "y".repeat(MAX_RECORDING_WORD_CHARS))]),
    ).toBe(null);
  });

  it("names the problem of each bad list", () => {
    const over = "x".repeat(MAX_RECORDING_WORD_CHARS + 1);
    const cases: [RecordingWord[], RecordingWordsProblem][] = [
      [[row("", "Client")], "empty_word"],
      [[row("   ", "Client")], "empty_word"],
      [[row("Acme", "")], "empty_stand_in"],
      [[row("Acme", "Client"), row("acme", "Other")], "duplicate_word"],
      [[row("Acme", "Bolt"), row("Bolt", "Crux")], "stand_in_is_a_word"],
      [[row("Acme", "Bolt"), row("bolt", "Crux")], "stand_in_is_a_word"],
      [[row(over, "Client")], "too_long"],
      [[row("Acme", over)], "too_long"],
      [
        Array.from({ length: MAX_RECORDING_WORDS + 1 }, (_, i) =>
          row(`word${i}`, `stand${i}`),
        ),
        "too_many",
      ],
    ];
    for (const [list, problem] of cases)
      expect({
        list: list.slice(0, 2),
        got: recordingWordsProblem(list),
      }).toEqual({
        list: list.slice(0, 2),
        got: problem,
      });
  });

  it("gives the office name as the default row, and nothing when there is no name", () => {
    const list = defaultRecordingWords("Nil's Office");
    expect(list.map((x) => x.word)).toEqual(["Nil's Office"]);
    expect(list[0].standIn.length).toBeGreaterThan(0);
    expect(list[0].standIn).not.toBe("Nil's Office");
    expect(recordingWordsProblem(list)).toBe(null);
    // And the redactor applies it.
    expect(
      redactWith({ words: list })("Welcome to Nil's Office"),
    ).not.toContain("Nil's");
    expect(defaultRecordingWords(null)).toEqual([]);
    expect(defaultRecordingWords("")).toEqual([]);
  });
});

// The page runs the redactor on the main thread for every text node and on
// every change, so its cost must grow with the text, not with its square. A
// long token with no space (a JWT, a minified line, a row of dots) once took
// seconds and froze the tab mid-recording. Each input below took 2 to 26 s
// on a quadratic pattern; a linear pass takes a few ms.
describe("recording mode: cost", () => {
  it("redacts long tokens with no space in time that grows with the text", () => {
    const words = Array.from({ length: MAX_RECORDING_WORDS }, (_, i) => ({
      word: `Customer${i} Name`,
      standIn: `C${i}`,
    }));
    // Paths and member names on too (task 1a5c9478).
    const members = Array.from({ length: 200 }, (_, i) => `Person ${i}`);
    const redact = redactWith({ words, members, paths: true });
    const N = 20_000;
    const inputs = {
      letters: "a".repeat(N),
      digits: "1".repeat(N),
      dotted: "ab12.".repeat(N / 5),
      dottedDigits: "1.".repeat(N / 2),
      dots: ".".repeat(N),
    };
    // Path-shaped runs: some of them are paths, so only the time counts.
    const pathy = {
      slashes: "/".repeat(N),
      segments: "/a".repeat(N / 2),
      relative: "a/".repeat(N / 2),
      tildes: "~/".repeat(N / 2),
      backslashes: "C:\\a".repeat(N / 4),
    };
    const took: Record<string, number> = {};
    for (const [name, text] of Object.entries(inputs)) {
      const start = performance.now();
      expect(redact(text)).toBe(text);
      took[name] = Math.round(performance.now() - start);
    }
    for (const [name, text] of Object.entries(pathy)) {
      const start = performance.now();
      redact(text);
      took[name] = Math.round(performance.now() - start);
    }
    for (const [name, ms] of Object.entries(took))
      expect({ name, slow: ms > 300 }).toEqual({ name, slow: false });
  });
});
