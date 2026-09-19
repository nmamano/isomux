import { translatorFor } from "../shared/i18n/translate";
import type { PlainMessageKey } from "../shared/i18n/translate";
import type { ExtensionUIState } from "../shared/browser-extension-protocol";
const language = navigator.language.split("-")[0];
const { t } = translatorFor(
  language === "es" || language === "ca" || language === "zh" ? language : "en",
);
document.documentElement.lang = language;
const element = (id: string) => document.getElementById(id)!;
const office = element("office") as HTMLInputElement;
const code = element("code") as HTMLInputElement;
const [invocationTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const labels: Record<string, PlainMessageKey> = {
  "office-label": "browser.office",
  "code-label": "browser.code",
  pair: "browser.pair",
  replace: "browser.replace",
  reconnect: "browser.reconnect",
  disconnect: "browser.disconnect",
  unpair: "browser.unpair",
  retained: "browser.retained",
  "offline-help": "browser.offlineHelp",
  "agent-label": "browser.agent",
  "allow-label": "browser.allow",
};
for (const [id, key] of Object.entries(labels))
  element(id).textContent = t(key);
let state: ExtensionUIState & { generation?: string };
let busy = false, showPair = false;
const picker = element("agent") as HTMLSelectElement;
const toggle = element("allow") as HTMLInputElement;
async function command(action: string, extra: Record<string, unknown> = {}) {
  if (busy && action !== "state" && action !== "stop") return;
  if (action !== "state") busy = true;
  if (action !== "state") element("error").textContent = "";
  try {
    if (action === "offer") {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active?.id !== invocationTab?.id) throw new Error();
    }
    const result = (await chrome.runtime.sendMessage({
      action,
      generation: state?.generation,
      tabId: invocationTab?.id,
      windowId: invocationTab?.windowId,
      ...extra,
    })) as typeof state & { error?: string };
    if (!result || result.error) throw new Error();
    if (action === "pair") {
      code.value = "";
      showPair = false;
    }
    render(result);
  } catch {
    element("error").textContent = t("browser.failed");
  } finally {
    if (action !== "state") busy = false;
  }
}
function render(next: typeof state) {
  state = next;
  element("status").dataset.state = state.state;
  element("status").textContent = t(`browser.${state.state}`);
  element("member").textContent = state.member
    ? t("browser.owner", { name: state.member.name })
    : "";
  element("office-display").textContent = state.office;
  if (!office.value) office.value = state.office;
  element("pair-form").hidden =
    !showPair && !["unpaired", "blocked", "unknown"].includes(state.state);
  element("replace").hidden = !element("pair-form").hidden;
  element("disconnect").hidden = ![
    "connected",
    "connecting",
    "offline",
  ].includes(state.state);
  element("reconnect").hidden = !["disabled", "offline"].includes(state.state);
  element("unpair").hidden = state.state !== "connected";
  element("offline-help").hidden =
    state.state === "connected" || state.state === "unpaired";
  const current = state.assignments.find((a) => a.current);
  const selected = current?.agent.id ?? picker.value;
  picker.replaceChildren();
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = agent.name;
    picker.append(option);
  }
  if (current && !state.agents.some((a) => a.id === current.agent.id)) {
    const option = document.createElement("option");
    option.value = current.agent.id;
    option.textContent = current.agent.name;
    picker.append(option);
  }
  if ([...picker.options].some((option) => option.value === selected)) picker.value = selected;
  picker.disabled = !!current || state.state !== "connected";
  const conflict = state.assignments.some((a) => a.agent.id === picker.value && !a.current);
  toggle.checked = !!current && current.phase !== "revoking";
  toggle.disabled = current ? current.phase === "revoking" :
    state.state !== "connected" || !state.currentTab?.eligible || !picker.value || conflict;
  element("tab-state").textContent = current
    ? t(current.phase === "on" ? "browser.assigned" : current.phase === "offering" ? "browser.offering" : "browser.revoking", { name: current.agent.name })
    : !state.currentTab?.eligible ? t("browser.tabIneligible")
      : conflict ? t("browser.tabConflict") : t("browser.tabOff");
}
element("replace").addEventListener("click", () => {
  showPair = true;
  render(state);
});
element("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void command("pair", { office: office.value, code: code.value });
});
for (const action of ["disconnect", "reconnect", "unpair"])
  element(action).addEventListener("click", () => void command(action));
picker.addEventListener("change", () => render(state));
toggle.addEventListener("change", () => {
  const current = state.assignments.find((a) => a.current);
  if (current) void command("stop", { assignment: current.id });
  else void command("offer", { agent: picker.value, tabId: state.currentTab?.id });
  toggle.disabled = true;
});
void command("state");
const poll = setInterval(() => void command("state"), 1000);
window.addEventListener("pagehide", () => clearInterval(poll));
