import { translatorFor } from "../shared/i18n/translate";
import type { PlainMessageKey } from "../shared/i18n/translate";
import type { ExtensionUIState } from "../shared/browser-extension-protocol";
const language = navigator.language.split("-")[0];
const { t } = translatorFor(language === "es" || language === "ca" || language === "zh" ? language : "en");
document.documentElement.lang = language;
const element = (id: string) => document.getElementById(id)!;
const office = element("office") as HTMLInputElement;
const code = element("code") as HTMLInputElement;
const labels: Record<string, PlainMessageKey> = {
  "office-label": "browser.office", "code-label": "browser.code", pair: "browser.pair",
  replace: "browser.replace", reconnect: "browser.reconnect", disconnect: "browser.disconnect", unpair: "browser.unpair",
  retained: "browser.retained", "offline-help": "browser.offlineHelp",
};
for (const [id, key] of Object.entries(labels)) element(id).textContent = t(key);
let state: ExtensionUIState & { generation?: string };
let busy = false, lastAssignments = "", showPair = false;
async function command(action: string, extra: Record<string, unknown> = {}) {
  if (busy) return;
  busy = true;
  if (action !== "state") element("error").textContent = "";
  try {
    const result = await chrome.runtime.sendMessage({ action, generation: state?.generation, ...extra }) as typeof state & { error?: string };
    if (!result || result.error) throw new Error();
    if (action === "pair") { code.value = ""; showPair = false; }
    render(result);
  } catch { element("error").textContent = t("browser.failed"); }
  finally { busy = false; }
}
function render(next: typeof state) {
  state = next;
  element("status").dataset.state = state.state;
  element("status").textContent = t(`browser.${state.state}`);
  element("member").textContent = state.member ? t("browser.owner", { name: state.member.name }) : "";
  element("office-display").textContent = state.office;
  if (!office.value) office.value = state.office;
  element("pair-form").hidden = !showPair && !["unpaired", "blocked", "unknown"].includes(state.state);
  element("replace").hidden = !element("pair-form").hidden;
  element("disconnect").hidden = !["connected", "connecting", "offline"].includes(state.state);
  element("reconnect").hidden = !["disabled", "offline"].includes(state.state);
  element("unpair").hidden = state.state !== "connected";
  element("offline-help").hidden = state.state === "connected" || state.state === "unpaired";
  const signature = JSON.stringify([state.generation, state.assignments]);
  if (signature !== lastAssignments) {
    lastAssignments = signature;
    element("assignments").replaceChildren();
    for (const assignment of state.assignments) {
      const section = document.createElement("section"), label = document.createElement("p");
      section.dataset.assignment = assignment.id;
      section.dataset.tabId = String(assignment.tabId);
      label.textContent = assignment.agent.name;
      section.append(label);
      for (const action of ["focus", "stop"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.textContent = t(`browser.${action}`);
        button.addEventListener("click", () => void command(action, { assignment: assignment.id }));
        section.append(button);
      }
      element("assignments").append(section);
    }
  }
}
element("replace").addEventListener("click", () => { showPair = true; render(state); });
element("pair-form").addEventListener("submit", event => { event.preventDefault(); void command("pair", { office: office.value, code: code.value }); });
for (const action of ["disconnect", "reconnect", "unpair"]) element(action).addEventListener("click", () => void command(action));
void command("state");
const poll = setInterval(() => void command("state"), 1000);
window.addEventListener("pagehide", () => clearInterval(poll));
