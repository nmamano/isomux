import { language, t } from "./i18n";
import type { ExtensionPlainKey } from "./i18n";
import {
  fields,
  type BrowserAccess,
  type ExtensionUIState,
} from "../shared/browser-extension-protocol";
import {
  pairedCode,
  readPairingDraft,
  savePairingDraft,
} from "./pairing-draft";
import { newerFiles } from "./disk-files";
import { ownMute } from "./own-mute";
document.documentElement.lang = language;
const element = (id: string) => document.getElementById(id)!;
const office = element("office") as HTMLInputElement;
const code = element("code") as HTMLInputElement;
const codeVisibility = element("code-visibility") as HTMLButtonElement;
function revealCode(reveal: boolean) {
  code.type = reveal ? "text" : "password";
  codeVisibility.textContent = t(reveal ? "browser.hide" : "browser.show");
  codeVisibility.setAttribute("aria-pressed", String(reveal));
}
revealCode(false);
codeVisibility.addEventListener("click", () =>
  revealCode(code.type === "password"),
);
// Fill the pairing form back in before the first render, which would
// otherwise put the paired office in an empty office field.
const draft = await readPairingDraft();
office.value = draft.office;
code.value = draft.code;
for (const field of [office, code])
  field.addEventListener(
    "input",
    () => void savePairingDraft({ office: office.value, code: code.value }),
  );
const [invocationTab] = await chrome.tabs.query({
  active: true,
  currentWindow: true,
});
const labels: Record<string, ExtensionPlainKey> = {
  "office-heading": "browser.officeSection",
  "office-label": "browser.office",
  "code-label": "browser.code",
  pair: "browser.pair",
  replace: "browser.replace",
  reconnect: "browser.reconnect",
  disconnect: "browser.disconnect",
  unpair: "browser.unpair",
  retained: "browser.retained",
  "offline-help": "browser.offlineHelp",
  "update-ready": "browser.updateReady",
  "update-steps": "browser.updateStepsPopup",
  "update-files-ready": "browser.filesReady",
  "update-reload": "browser.reload",
  "update-reload-note": "browser.reloadNote",
  "update-store": "browser.updateStore",
  "store-link": "browser.storeInstall",
  "agents-label": "browser.agents",
  "agents-mine": "browser.myAgents",
  "agents-members": "browser.pickedAgents",
  "agents-office": "browser.allAgents",
  "members-none": "browser.membersNone",
  "allow-label": "browser.useTab",
  "open-tabs-label": "browser.openTabs",
  "unmute-tab": "browser.unmuteTab",
  "share-label": "browser.shareSection",
  share: "browser.share",
};
for (const [id, key] of Object.entries(labels))
  element(id).textContent = t(key);
// The popup unmutes a tab this extension muted, paired or not.
const unmute = element("unmute-tab");
const mutedTab = ownMute(invocationTab?.mutedInfo)
  ? invocationTab?.id
  : undefined;
unmute.hidden = mutedTab === undefined;
unmute.addEventListener("click", () => {
  if (mutedTab === undefined) return;
  void chrome.tabs.update(mutedTab, { muted: false }).then(
    () => {
      unmute.hidden = true;
    },
    () => {},
  );
});
let state: ExtensionUIState & { generation?: string };
// The version of newer extension files on disk. The popup reads them itself,
// so its Reload also works while an older background runs.
let files: string | undefined;
async function readFiles() {
  files = await newerFiles();
  if (state) render(state);
}
element("update-reload").addEventListener("click", () => {
  void newerFiles().then((next) => {
    if (next) chrome.runtime.reload();
    else {
      files = undefined;
      if (state) render(state);
    }
  });
});
let busy = false,
  showPair = false;
const picker = element("agents") as HTMLSelectElement;
const membersBox = element("members");
const membersList = element("members-list");
const toggle = element("allow") as HTMLInputElement;
const openTabs = element("open-tabs") as HTMLInputElement;
const agentTabsList = element("agent-tabs-list");
// The member rows shown, so a poll that changes nothing keeps the focus.
let memberRows = "";
// The rows shown, so a poll that changes nothing keeps the buttons.
let agentTabRows = "";
async function command(action: string, extra: Record<string, unknown> = {}) {
  if (busy && !["state", "stop", "close"].includes(action)) return;
  if (action !== "state") busy = true;
  if (action !== "state") element("error").textContent = "";
  // Why the background refused, when it names a cause the member can fix.
  let reason: string | undefined;
  try {
    if (action === "offer") {
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (active?.id !== invocationTab?.id) throw new Error();
    }
    const result = (await chrome.runtime.sendMessage({
      action,
      generation: state?.generation,
      tabId: invocationTab?.id,
      windowId: invocationTab?.windowId,
      ...extra,
    })) as typeof state & { error?: string; reason?: string };
    if (!result || result.error) {
      reason = result?.reason;
      throw new Error();
    }
    // A returned pair command is not pairing: the code stays in the form until
    // the office confirms it, so a refused or mistyped attempt can be fixed.
    if (action === "pair") showPair = false;
    // Read the field only after the await: a code typed during it is newer.
    const paired = await pairedCode();
    if (code.value && code.value.trim() === paired) code.value = "";
    render(result);
  } catch {
    element("error").textContent = t(
      reason === "unanswered" ? "browser.tabUnanswered" : "browser.failed",
    );
  } finally {
    // Unlock the controls the command locked.
    if (action !== "state") {
      busy = false;
      if (state) render(state);
    }
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
  const pairForm = element("pair-form");
  const pairHidden =
    !showPair && !["unpaired", "blocked", "unknown"].includes(state.state);
  if (pairForm.hidden !== pairHidden) revealCode(false);
  pairForm.hidden = pairHidden;
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
  // Chrome updates a store install by itself: no download and no Reload.
  const store = state.store === true;
  element("update").hidden = store ? !state.update : !state.update && !files;
  element("update-store").hidden = !store;
  element("update-office").hidden = store || !!files;
  element("update-files").hidden = store || !files;
  // An unpacked install links the store listing. Before a ready, as in the
  // pairing view, state.storeUrl is only the built-in CHROME_WEB_STORE_URL.
  const listing = !store && state.storeUrl;
  element("store-install").hidden = !listing;
  if (listing) {
    (element("store-link") as HTMLAnchorElement).href = listing;
    element("store-steps").textContent = t(
      state.state === "connected"
        ? "browser.storeStepsPaired"
        : "browser.storeSteps",
    );
  }
  if (state.update && !files) {
    const link = element("update-download") as HTMLAnchorElement;
    link.href = `${state.office}/api/me/browser/extension.zip`;
    link.textContent = t("browser.download", { version: state.update.latest });
  }
  renderAccess();
  const current = state.assignments.find((a) => a.current);
  toggle.checked = !!current && current.phase !== "revoking";
  toggle.disabled = current
    ? current.phase === "revoking"
    : busy || state.state !== "connected" || !state.currentTab?.eligible;
  element("tab-state").textContent = current
    ? current.phase === "offering"
      ? t("browser.offering")
      : current.phase === "revoking"
        ? t("browser.revoking")
        : current.scope.kind === "opened" && current.agent
          ? t("browser.assigned", { name: current.agent.name })
          : t("browser.tabShared")
    : state.state === "connected" && !state.currentTab?.eligible
      ? t("browser.tabIneligible")
      : "";
  renderAgentTabs();
  renderShare();
}
// The member's access setting: one picker for both switches. On an office
// without shared access, a members pick works as My agents and is kept.
const storedAccess = (): BrowserAccess =>
  state.access ?? { agents: "mine", members: [], openTabs: false };
function shownAccess(): BrowserAccess {
  const access = storedAccess();
  if (access.agents === "office" && !state.officeScope)
    return { ...access, agents: "mine" };
  if (access.agents === "members" && !state.sharedAccess)
    return { ...access, agents: "mine" };
  return access;
}
function renderAccess() {
  const access = shownAccess();
  (element("agents-members") as HTMLOptionElement).hidden = !state.sharedAccess;
  (element("agents-office") as HTMLOptionElement).hidden = !state.officeScope;
  picker.value = access.agents;
  picker.disabled = busy || state.state !== "connected";
  membersBox.hidden = access.agents !== "members";
  const members = state.members ?? [];
  const signature = JSON.stringify([members, access.members]);
  if (signature !== memberRows) {
    memberRows = signature;
    membersList.replaceChildren(
      ...members.map((member) => {
        const row = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = member.id;
        box.checked = access.members.includes(member.id);
        box.addEventListener("change", () =>
          sendAccess({
            members: box.checked
              ? [...storedAccess().members, member.id]
              : storedAccess().members.filter((id) => id !== member.id),
          }),
        );
        label.append(box, member.name);
        row.append(label);
        return row;
      }),
    );
  }
  element("members-none").hidden = members.length > 0;
  for (const box of membersList.querySelectorAll("input")) box.disabled = busy;
}
// Sends the stored setting with change applied; the background keeps it. A
// value the office cannot take is only shown differently, never overwritten.
function sendAccess(change: Partial<BrowserAccess>) {
  const access = { ...storedAccess(), ...change };
  // A pick for a member the office no longer lists stays stored.
  access.members = [...new Set(access.members)];
  void command("access", { access });
}
// Open their own tabs and the tabs agents opened, on an office that takes
// them.
function renderAgentTabs() {
  const section = element("agent-tabs");
  openTabs.checked = shownAccess().openTabs;
  openTabs.disabled = busy;
  section.hidden =
    !(state.agentTabs || state.sharedAccess) || state.state !== "connected";
  if (section.hidden) return;
  const rows = state.assignments.filter((a) => a.scope.kind === "opened");
  const signature = JSON.stringify(
    rows.map((a) => [a.id, a.agent?.name, a.manager?.name]),
  );
  if (signature === agentTabRows) return;
  agentTabRows = signature;
  agentTabsList.replaceChildren(
    ...rows.map((a) => {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = a.manager
        ? t("browser.agentTabOf", {
            agent: a.agent?.name ?? "",
            member: a.manager.name,
          })
        : (a.agent?.name ?? "");
      const show = document.createElement("button");
      show.type = "button";
      show.textContent = t("browser.focus");
      show.addEventListener(
        "click",
        () => void command("focus", { assignment: a.id }),
      );
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = t("browser.closeTab");
      close.addEventListener(
        "click",
        () => void command("close", { assignment: a.id }),
      );
      row.append(name, show, close);
      return row;
    }),
  );
}
// Share page with agent: the agents the member reaches, by room. The last
// pick is kept per office in chrome.storage.local.
const sharePicker = element("share-agent") as HTMLSelectElement;
const shareButton = element("share") as HTMLButtonElement;
const shareStatus = element("share-status");
let saved: { office?: unknown; agentId?: unknown } | undefined;
try {
  saved = fields((await chrome.storage.local.get("shareAgent")).shareAgent);
} catch {}
let sharePick: { office: string; agentId: string } | undefined =
  typeof saved?.office === "string" && typeof saved.agentId === "string"
    ? { office: saved.office, agentId: saved.agentId }
    : undefined;
let shareRows = "";
let sharing = false;
// The last share's ending, shown until the next share.
let shareNote = "";
// An http(s) page; the office checks the rest of the URL.
const shareUrl = /^https?:\/\//i.test(invocationTab?.url ?? "")
  ? invocationTab?.url
  : undefined;
function renderShare() {
  const section = element("share-section");
  section.hidden = state.state !== "connected" || !state.share;
  if (section.hidden) return;
  const agents = state.shareAgents ?? [];
  const signature = JSON.stringify(agents);
  if (signature !== shareRows) {
    shareRows = signature;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("browser.sharePick");
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const agent of agents) {
      let group = groups.get(agent.room);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = agent.room;
        groups.set(agent.room, group);
      }
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      group.append(option);
    }
    sharePicker.replaceChildren(placeholder, ...groups.values());
  }
  const picked =
    sharePick?.office === state.office &&
    agents.some((agent) => agent.id === sharePick!.agentId)
      ? sharePick.agentId
      : "";
  sharePicker.value = picked;
  shareButton.disabled = !picked || sharing || !shareUrl;
  shareStatus.textContent = shareUrl ? shareNote : t("browser.shareIneligible");
}
sharePicker.addEventListener("change", () => {
  sharePick = { office: state.office, agentId: sharePicker.value };
  void Promise.resolve()
    .then(() => chrome.storage.local.set({ shareAgent: sharePick }))
    .catch(() => {});
  shareNote = "";
  render(state);
});
// The selected text of the popup's tab, main frame only; "" on a page that
// takes no script.
async function selectedText(): Promise<string> {
  if (invocationTab?.id === undefined) return "";
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId: invocationTab.id },
      func: () => getSelection()?.toString() ?? "",
    });
    return typeof frame?.result === "string" ? frame.result : "";
  } catch {
    return "";
  }
}
shareButton.addEventListener("click", () => {
  const agent = state.shareAgents?.find((a) => a.id === sharePicker.value);
  if (sharing || !agent || !shareUrl) return;
  sharing = true;
  shareNote = "";
  render(state);
  void (async () => {
    let result: string | undefined;
    try {
      const selection = await selectedText();
      const answer = (await chrome.runtime.sendMessage({
        action: "share",
        generation: state.generation,
        tabId: invocationTab?.id,
        agentId: agent.id,
        url: shareUrl,
        title: invocationTab?.title ?? "",
        ...(selection ? { selection } : {}),
      })) as (typeof state & { error?: string }) | undefined;
      if (answer && !answer.error) {
        result = answer.shareResult;
        state = answer;
      }
    } catch {}
    sharing = false;
    shareNote =
      result === "sent"
        ? t("browser.shareSent", { name: agent.name })
        : result === "unanswered"
          ? t("browser.shareUnanswered")
          : result === "awaits_member_answer"
            ? t("browser.shareWaits", { name: agent.name })
            : t("browser.shareFailed");
    render(state);
  })();
});
element("replace").addEventListener("click", () => {
  revealCode(false);
  showPair = true;
  render(state);
});
element("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  revealCode(false);
  void command("pair", { office: office.value, code: code.value });
});
for (const action of ["disconnect", "reconnect", "unpair"])
  element(action).addEventListener("click", () => void command(action));
picker.addEventListener("change", () =>
  sendAccess({ agents: picker.value as BrowserAccess["agents"] }),
);
openTabs.addEventListener("change", () =>
  sendAccess({ openTabs: openTabs.checked }),
);
toggle.addEventListener("change", () => {
  const current = state.assignments.find((a) => a.current);
  if (current) void command("stop", { assignment: current.id });
  else void command("offer", { tabId: state.currentTab?.id });
  toggle.disabled = true;
});
void command("state");
void readFiles();
const poll = setInterval(() => {
  void command("state");
  void readFiles();
}, 1000);
window.addEventListener("pagehide", () => {
  revealCode(false);
  clearInterval(poll);
});
