import { test, expect } from "bun:test";
import { setUpDomTestFile } from "../ui/test-support/dom";

setUpDomTestFile();
const { runInNewContext } = await import("node:vm");
const { readFile } = await import("node:fs/promises");

test("popup defaults to Never, freezes the chosen duration and renders the server deadline", async () => {
  document.body.innerHTML = (await readFile("browser-extension/connection.html", "utf8")).split("<body>")[1].split("</body>")[0];
  const build = Bun.spawnSync(["bun", "build", "browser-extension/connection.ts", "--target=browser"]);
  expect(build.exitCode).toBe(0);
  type Assignment = { scope: { kind: "agent"; agentId: string }; id: string; agent: { id: string; name: string }; tabId: number; current: boolean; phase: string; durationMinutes: number; expiresAt: number | null };
  let state = { state: "connected", generation: "g", office: "https://example.com", currentTab: { id: 7, eligible: true },
    agents: [{ id: "a", name: "Agent" }], assignments: [] as Assignment[] };
  const messages: Record<string, unknown>[] = [];
  let poll!: () => void;
  let accept!: (value: typeof state & { error?: string }) => void;
  const pending = () => new Promise<typeof state>(resolve => { accept = resolve; });
  await runInNewContext(`(async () => { ${build.stdout.toString()} })()`, {
    document, window, navigator: { language: "en" }, Date,
    chrome: { tabs: { query: async () => [{ id: 7, windowId: 1 }] }, runtime: {
      sendMessage: async (message: Record<string, unknown>) => {
        messages.push(message);
        return message.action === "offer" ? pending() : structuredClone(state);
      },
    } },
    setInterval: (callback: () => void) => { poll = callback; return 1; }, clearInterval() {},
  });
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
  const expiry = document.getElementById("expiry") as HTMLSelectElement;
  const toggle = document.getElementById("allow") as HTMLInputElement;
  const picker = document.getElementById("agent") as HTMLSelectElement;
  const display = document.getElementById("expiry-state")!;
  await settle();
  expect([...expiry.options].map(option => option.value)).toEqual(["0", "15", "60", "240"]);
  expect(expiry.value).toBe("0");
  expect(expiry.disabled).toBe(false);
  expect(document.querySelector("#office-control #status")).not.toBeNull();
  expect(document.querySelector("#tab-control #agent")).not.toBeNull();
  expect((document.getElementById("agent") as HTMLSelectElement).value).toBe("all");
  expect(toggle.getAttribute("role")).toBe("switch");
  expect(toggle.checked).toBe(false);
  expect(document.getElementById("tab-state")!.textContent).toBe("");
  expiry.value = "15";
  toggle.dispatchEvent(new Event("change", { bubbles: true }));
  expect(picker.disabled).toBe(true);
  await settle();
  expect(messages.findLast(message => message.action === "offer")?.durationMinutes).toBe(15);
  expect(messages.findLast(message => message.action === "offer")?.scope).toEqual({ kind: "all" });
  expect(picker.disabled).toBe(true);
  poll(); await settle(); // Empty pre-ack metadata must not unlock the request.
  expect(picker.disabled).toBe(true);
  expect(toggle.disabled).toBe(true);
  expect(expiry.disabled).toBe(true);
  accept({ ...structuredClone(state), error: "fixture rejected offer" }); await settle();
  expect(document.getElementById("error")!.textContent).not.toBe("");
  poll(); await settle();
  expect(picker.disabled).toBe(false);
  expect(toggle.disabled).toBe(false);
  expect(toggle.checked).toBe(false);
  expect(expiry.disabled).toBe(false);
  toggle.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  expect(picker.disabled).toBe(true);

  const assignment: Assignment = { scope: { kind: "agent", agentId: "a" }, id: "grant", agent: state.agents[0], tabId: 7, current: true, phase: "offering", durationMinutes: 15, expiresAt: null };
  state = { ...state, assignments: [assignment] };
  poll(); await settle();
  expect(expiry.value).toBe("15");
  expect(expiry.disabled).toBe(true);
  expect(display.textContent).toBe("");
  const expiresAt = 1_800_123_456_000;
  state = { ...state, assignments: [{ ...assignment, phase: "on", expiresAt }] };
  accept(structuredClone(state)); await settle();
  expect(display.textContent).toContain(new Date(expiresAt).toLocaleString());
  expect(expiry.disabled).toBe(true);
  expect(toggle.checked).toBe(true);
  expect(picker.disabled).toBe(true);
  state = { ...state, assignments: [{ ...state.assignments[0], phase: "revoking" }] };
  poll(); await settle();
  expect(expiry.disabled).toBe(true);
  expect(expiry.value).toBe("15");
  state = { ...state, assignments: [] };
  poll(); await settle();
  expect(expiry.disabled).toBe(false);
  expect(expiry.value).toBe("0");
  toggle.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  expect(messages.findLast(message => message.action === "offer")?.durationMinutes).toBe(0);
  state = { ...state, assignments: [{ ...assignment, id: "new", phase: "on", durationMinutes: 0, expiresAt: null }] };
  accept(structuredClone(state)); await settle();
  expect(expiry.value).toBe("0");
  expect(expiry.disabled).toBe(true);
  expect(display.textContent).toContain(expiry.options[0].textContent);
  window.dispatchEvent(new Event("pagehide"));
});

for (const language of ["en", "es", "ca", "zh"]) {
  test(`pairing code stays masked unless explicitly shown, including replacement and failed submit (${language})`, async () => {
    document.body.innerHTML = (await readFile("browser-extension/connection.html", "utf8")).split("<body>")[1].split("</body>")[0];
    const code = document.getElementById("code") as HTMLInputElement;
    const reveal = document.getElementById("code-visibility") as HTMLButtonElement;
    const form = document.getElementById("pair-form") as HTMLFormElement;
    const replace = document.getElementById("replace") as HTMLButtonElement;
    expect(code.type).toBe("password");
    expect(reveal.type).toBe("button");
    expect(reveal.getAttribute("aria-controls")).toBe(code.id);
    expect(reveal.getAttribute("aria-describedby")).toBe("code-label");
    const build = Bun.spawnSync(["bun", "build", "browser-extension/connection.ts", "--target=browser"]);
    expect(build.exitCode).toBe(0);
    let state = { state: "unpaired", office: "", agents: [], assignments: [] };
    let finish!: (value: typeof state & { error?: string }) => void;
    const sent: Record<string, unknown>[] = [];
    await runInNewContext(`(async () => { ${build.stdout.toString()} })()`, {
      document, window, navigator: { language }, Date,
      chrome: { tabs: { query: async () => [{ id: 7, windowId: 1 }] }, runtime: {
        sendMessage: (message: Record<string, unknown>) => {
          sent.push(message);
          return message.action === "pair" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(structuredClone(state));
        },
      } },
      setInterval: () => 1, clearInterval() {},
    });
    const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
    await settle();
    const maskedLabel = reveal.textContent;
    expect(maskedLabel).toBeTruthy();
    expect(form.hidden).toBe(false);
    code.value = "fixture-only-pairing-code";
    reveal.click();
    expect(code.type).toBe("text");
    expect(reveal.getAttribute("aria-pressed")).toBe("true");
    expect(reveal.textContent).not.toBe(maskedLabel);
    expect(sent.filter(message => message.action === "pair")).toHaveLength(0);
    reveal.click();
    expect(code.type).toBe("password");
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    reveal.click();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(code.type).toBe("password");
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    expect(sent.at(-1)).toMatchObject({ action: "pair", code: "fixture-only-pairing-code" });
    finish({ ...state, error: "fixture failure" }); await settle();
    expect(code.type).toBe("password");
    expect(code.value).toBe("fixture-only-pairing-code");
    reveal.click();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(code.type).toBe("password");
    state = { ...state, state: "connected", office: "https://example.com" };
    finish(state); await settle();
    expect(code.value).toBe("");
    expect(form.hidden).toBe(true);
    // Reopening replacement pairing resets even an explicitly revealed field.
    reveal.click();
    expect(code.type).toBe("text");
    replace.click();
    expect(form.hidden).toBe(false);
    expect(code.type).toBe("password");
    code.value = "replacement-fixture";
    reveal.click();
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(code.type).toBe("password");
    finish(state); await settle();
    replace.click();
    expect(code.type).toBe("password");
    expect(code.value).toBe("");
    reveal.click();
    window.dispatchEvent(new Event("pagehide"));
    expect(code.type).toBe("password");
  });
}
