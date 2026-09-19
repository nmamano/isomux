import { test, expect } from "bun:test";
import { setUpDomTestFile } from "../ui/test-support/dom";

setUpDomTestFile();
const { runInNewContext } = await import("node:vm");
const { readFile } = await import("node:fs/promises");

test("popup defaults to Never, freezes the chosen duration and renders the server deadline", async () => {
  document.body.innerHTML = (await readFile("browser-extension/connection.html", "utf8")).split("<body>")[1].split("</body>")[0];
  const build = Bun.spawnSync(["bun", "build", "browser-extension/connection.ts", "--target=browser"]);
  expect(build.exitCode).toBe(0);
  type Assignment = { id: string; agent: { id: string; name: string }; tabId: number; current: boolean; phase: string; durationMinutes: number; expiresAt: number | null };
  let state = { state: "connected", generation: "g", office: "https://example.com", currentTab: { id: 7, eligible: true },
    agents: [{ id: "a", name: "Agent" }], assignments: [] as Assignment[] };
  const messages: Record<string, unknown>[] = [];
  let poll!: () => void;
  let accept!: (value: typeof state) => void;
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
  const display = document.getElementById("expiry-state")!;
  await settle();
  expect([...expiry.options].map(option => option.value)).toEqual(["0", "15", "60", "240"]);
  expect(expiry.value).toBe("0");
  expect(expiry.disabled).toBe(false);
  expiry.value = "15";
  toggle.dispatchEvent(new Event("change", { bubbles: true })); await settle();
  expect(messages.findLast(message => message.action === "offer")?.durationMinutes).toBe(15);
  const assignment: Assignment = { id: "grant", agent: state.agents[0], tabId: 7, current: true, phase: "offering", durationMinutes: 15, expiresAt: null };
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
