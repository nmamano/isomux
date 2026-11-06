// Recording mode's DOM layer (task 6e08239a), on happy-dom: attachRedactor
// rewrites what the page draws and gives it back, installClickReveal keeps
// pictures blurred until one gesture, and the switch (setRecording) turns
// both on and off with the tab title and favicon as the on-indicator. The
// elevator ride carries "on" to the next office.
//
// The redactor here is a stand-in written for the test, not compileRedactor:
// the text rules are pinned in shared/recording-redact.test.ts, and this file
// pins only how the page applies whatever the rules return.
//
// Not here: layout (happy-dom has none). The iframe hit test, the blur
// itself and a real mouse are checked in a browser at review.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const {
  RECORDING_STORAGE_KEY,
  attachRedactor,
  currentRedactor,
  installClickReveal,
  isRecording,
  onRecordingChange,
  setRecording,
  setRecordingRules,
  startRecordingMode,
} = await import("./recording-mode.ts");
const { holdArrivingPanel, rideFragment, syncPanel } =
  await import("./elevator-panel-store.ts");
const { PANEL_HASH_KEY, PANEL_SESSION_KEY } =
  await import("../shared/elevator-panel.ts");

type Redactor = import("../shared/recording-redact.ts").Redactor;

// "Acme" -> "Client Co", or "Xy" padded to the match with keepLength.
const redact: Redactor = (text, opts) =>
  text.replace(/Acme/g, opts?.keepLength ? "Xy  " : "Client Co");
// A rule change: the page must start again from the originals.
const redact2: Redactor = (text) => text.replace(/Acme/g, "Delta");

// MutationObserver callbacks; happy-dom may deliver them a turn later than
// a browser does.
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

const detachers: (() => void)[] = [];
afterEach(() => {
  for (const d of detachers.splice(0)) d();
  setRecording(false);
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Nothing kept.
  }
  document.body.innerHTML = "";
  document.title = "";
  for (const el of document.head.querySelectorAll("link[rel~='icon']"))
    el.remove();
  history.replaceState(null, "", "/");
});

function attach(r: Redactor = redact) {
  const a = attachRedactor(document, r);
  detachers.push(() => a.detach());
  return a;
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

// One press of the main button, as a browser sends it. Returns false when the
// click was cancelled.
function gesture(el: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"])
    el.dispatchEvent(
      new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
  return el.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
  );
}

describe("attachRedactor", () => {
  it("rewrites the text and the drawn attributes already on the page, HTML and SVG", () => {
    document.title = "Acme board";
    const host = mount(
      `<p id="p">Hello Acme</p>` +
        `<svg><text id="svg">Acme HQ</text></svg>` +
        `<button id="b" title="Acme tip" aria-label="Acme label">x</button>` +
        `<img id="i" alt="Acme logo">` +
        `<input id="in" placeholder="Acme here">`,
    );
    attach();
    const $ = (id: string) => host.querySelector(`#${id}`)!;
    expect($("p").textContent).toBe("Hello Client Co");
    expect($("svg").textContent).toBe("Client Co HQ");
    expect($("b").getAttribute("title")).toBe("Client Co tip");
    expect($("b").getAttribute("aria-label")).toBe("Client Co label");
    expect($("i").getAttribute("alt")).toBe("Client Co logo");
    expect($("in").getAttribute("placeholder")).toBe("Client Co here");
    expect(document.title).toContain("Client Co board");
    expect(document.title).not.toContain("Acme");
  });

  // A stand-in in an editable field would be saved back as the real value.
  it("never rewrites scripts, styles, editable fields or a CodeMirror editor", () => {
    const host = mount(
      `<script type="text/plain" id="s">Acme</script>` +
        `<style id="st">/* Acme */</style>` +
        `<noscript id="n">Acme</noscript>` +
        `<textarea id="t">Acme</textarea>` +
        `<div contenteditable="true" id="ce"><span>Acme</span></div>` +
        `<div class="cm-editor" id="cm"><div class="cm-line">Acme</div></div>` +
        `<p id="p">Acme</p>`,
    );
    attach();
    const $ = (id: string) => host.querySelector(`#${id}`)!;
    expect($("p").textContent).toBe("Client Co");
    for (const id of ["s", "st", "n", "ce", "cm"])
      expect({ id, text: $(id).textContent!.includes("Acme") }).toEqual({
        id,
        text: true,
      });
    expect(($("t") as HTMLTextAreaElement).value).toBe("Acme");
  });

  it("blurs an editable field whose value matches, and follows its edits without changing the value", async () => {
    const host = mount(
      `<input id="a" value="Acme Inc">` +
        `<input id="b" value="nothing">` +
        `<textarea id="t">Acme</textarea>` +
        `<div contenteditable="true" id="ce">Acme</div>`,
    );
    attach();
    const $ = (id: string) => host.querySelector(`#${id}`) as HTMLInputElement;
    const blurred = (id: string) => $(id).hasAttribute("data-recording-blur");
    expect(["a", "b", "t", "ce"].map(blurred)).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect($("a").value).toBe("Acme Inc");

    $("b").value = "call Acme";
    $("b").dispatchEvent(new Event("input", { bubbles: true }));
    $("a").value = "clean now";
    $("a").dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
    expect([blurred("a"), blurred("b")]).toEqual([false, true]);
    expect($("b").value).toBe("call Acme");
  });

  // React sets a controlled field's value with no input event: a removed
  // row in a list, a restored draft. The blur must follow the value shown.
  it("follows a field value React sets, with no input event", async () => {
    const { act, render } = await import("@testing-library/react");
    const { createElement } = await import("react");
    const fields = (a: string, b: string) =>
      createElement(
        "div",
        null,
        createElement("input", { id: "in", value: a, onChange: () => {} }),
        createElement("textarea", { id: "ta", value: b, onChange: () => {} }),
      );
    const view = render(fields("clean", "clean"));
    attach();
    const blurred = (id: string) =>
      document.getElementById(id)!.hasAttribute("data-recording-blur");
    expect([blurred("in"), blurred("ta")]).toEqual([false, false]);
    await act(async () => view.rerender(fields("Acme Inc", "call Acme")));
    await flush();
    expect([blurred("in"), blurred("ta")]).toEqual([true, true]);
    expect((document.getElementById("in") as HTMLInputElement).value).toBe(
      "Acme Inc",
    );
    await act(async () => view.rerender(fields("clean", "clean")));
    await flush();
    expect([blurred("in"), blurred("ta")]).toEqual([false, false]);
    view.unmount();
  });

  it("rewrites what changes later: new nodes, edited text and attributes", async () => {
    const host = mount(`<p id="p">plain</p>`);
    attach();
    const p = host.querySelector("#p")!;
    p.firstChild!.nodeValue = "now Acme";
    const added = document.createElement("span");
    added.textContent = "Acme joined";
    host.append(added);
    p.setAttribute("title", "Acme");
    await flush();
    expect(p.textContent).toBe("now Client Co");
    expect(added.textContent).toBe("Client Co joined");
    expect(p.getAttribute("title")).toBe("Client Co");
  });

  // The redactor below is not a fixed point ("Acme" -> "Acme!"): a layer
  // that scans its own writes again grows the text on every pass.
  it("never redacts its own write again", async () => {
    const grow: Redactor = (t) => t.replace(/Acme/g, "Acme!");
    const host = mount(`<p id="p">Acme</p>`);
    attach(grow);
    for (let i = 0; i < 3; i++) await flush();
    expect(host.querySelector("#p")!.textContent).toBe("Acme!");
  });

  it("pads or cuts a terminal row's stand-in to the match", () => {
    const host = mount(
      `<div class="xterm-rows"><div><span id="row">$ ping Acme ok</span></div></div>` +
        `<p id="p">Acme</p>`,
    );
    attach();
    expect(host.querySelector("#row")!.textContent).toBe("$ ping Xy   ok");
    expect(host.querySelector("#p")!.textContent).toBe("Client Co");
  });

  it("detach gives back every original, and stops rewriting", async () => {
    document.title = "Acme board";
    const host = mount(
      `<p id="p">Hello Acme</p><b id="b" title="Acme">x</b><input id="in" value="Acme">`,
    );
    const a = attach();
    a.detach();
    expect(host.querySelector("#p")!.textContent).toBe("Hello Acme");
    expect(host.querySelector("#b")!.getAttribute("title")).toBe("Acme");
    expect(host.querySelector("#in")!.hasAttribute("data-recording-blur")).toBe(
      false,
    );
    expect(document.title).toBe("Acme board");
    const later = document.createElement("p");
    later.textContent = "Acme later";
    host.append(later);
    await flush();
    expect(later.textContent).toBe("Acme later");
  });

  // React (or anything else) wrote a new value after the layer's write and
  // before the layer saw it. Detach must not put the older original back
  // over it.
  it("detach keeps a value the page changed after the layer wrote", () => {
    const host = mount(`<p id="p">Acme 1</p>`);
    const a = attach();
    const text = host.querySelector("#p")!.firstChild!;
    expect(text.nodeValue).toBe("Client Co 1");
    text.nodeValue = "Acme 2";
    a.detach();
    expect(text.nodeValue).toBe("Acme 2");
  });

  it("update starts again from the originals, also for text the page changed since", async () => {
    const host = mount(`<p id="p">Acme 1</p><i id="i" title="Acme t">x</i>`);
    const a = attach();
    const p = host.querySelector("#p")!;
    p.firstChild!.nodeValue = "Acme 2";
    await flush();
    a.update(redact2);
    expect(p.textContent).toBe("Delta 2");
    expect(host.querySelector("#i")!.getAttribute("title")).toBe("Delta t");
    a.detach();
    expect(p.textContent).toBe("Acme 2");
  });
});

describe("installClickReveal", () => {
  function setup() {
    document.documentElement.setAttribute("data-recording", "");
    const host = mount(
      `<a id="link" href="#open"><img id="img" src="/a.png" alt="shot"></a>` +
        `<button id="btn">Send</button>`,
    );
    const seen: string[] = [];
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ])
      host.addEventListener(type, (e) =>
        seen.push(`${type}:${(e.target as Element).id}`),
      );
    const uninstall = installClickReveal(document);
    detachers.push(() => {
      uninstall();
      document.documentElement.removeAttribute("data-recording");
    });
    return { host, seen, uninstall };
  }

  it("the first gesture on a blurred picture only reveals it; the next one acts", () => {
    const { host, seen } = setup();
    const img = host.querySelector("#img")!;
    expect(img.hasAttribute("data-recording-shown")).toBe(false);
    const notCancelled = gesture(img);
    expect(img.hasAttribute("data-recording-shown")).toBe(true);
    // Nothing under the picture saw any part of the first gesture, and the
    // link did not follow.
    expect(seen).toEqual([]);
    expect(notCancelled).toBe(false);

    gesture(img);
    expect(seen).toEqual([
      "pointerdown:img",
      "mousedown:img",
      "pointerup:img",
      "mouseup:img",
      "click:img",
    ]);
  });

  it("leaves a gesture on anything else alone", () => {
    const { host, seen } = setup();
    gesture(host.querySelector("#btn")!);
    expect(seen).toContain("click:btn");
    expect(
      host.querySelector("#img")!.hasAttribute("data-recording-shown"),
    ).toBe(false);
  });

  // The lightbox reuses one img for next/prev, and a preview re-renders in
  // place: a reveal is for the picture that was clicked, not the element.
  it("blurs again when the picture in a revealed element changes", async () => {
    const { host } = setup();
    const img = host.querySelector("#img")!;
    gesture(img);
    expect(img.hasAttribute("data-recording-shown")).toBe(true);
    img.setAttribute("src", "/b.png");
    await flush();
    expect(img.hasAttribute("data-recording-shown")).toBe(false);

    const frame = document.createElement("iframe");
    frame.setAttribute("data-recording-shown", "");
    frame.setAttribute("srcdoc", "<p>one</p>");
    host.append(frame);
    await flush();
    frame.setAttribute("srcdoc", "<p>two</p>");
    await flush();
    expect(frame.hasAttribute("data-recording-shown")).toBe(false);
  });

  it("uninstall drops every reveal and lets gestures through", () => {
    const { host, seen, uninstall } = setup();
    const img = host.querySelector("#img")!;
    gesture(img);
    uninstall();
    expect(img.hasAttribute("data-recording-shown")).toBe(false);
    gesture(img);
    expect(seen).toContain("click:img");
  });
});

describe("the switch", () => {
  const RULES = {
    officeHosts: [],
    otherOffices: [],
    words: [{ word: "Acme", standIn: "Client" }],
  };

  function favicon(): string {
    const link = document.createElement("link");
    link.rel = "icon";
    link.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
    document.head.append(link);
    return link.href;
  }
  // The browser shows the last icon link in the head.
  const iconShown = () =>
    [
      ...document.head.querySelectorAll<HTMLLinkElement>("link[rel~='icon']"),
    ].at(-1)?.href;

  it("on: redacts with the rules, marks the page, shows the indicator in the title and favicon; off undoes all of it", async () => {
    const icon = favicon();
    document.title = "Acme - Isomux";
    const host = mount(`<p id="p">Acme</p><img id="img" src="/a.png">`);
    setRecordingRules(RULES);
    let changes = 0;
    const unsubscribe = onRecordingChange(() => changes++);

    setRecording(true);
    expect(isRecording()).toBe(true);
    expect(localStorage.getItem(RECORDING_STORAGE_KEY)).not.toBe(null);
    expect(currentRedactor()?.("Acme")).toBe("Client");
    expect(document.documentElement.hasAttribute("data-recording")).toBe(true);
    expect(host.querySelector("#p")!.textContent).toBe("Client");
    // The indicator is outside the page: the title gains a mark at its start,
    // the favicon changes.
    expect(document.title).not.toContain("Acme");
    expect(document.title.endsWith("Client - Isomux")).toBe(true);
    expect(document.title.length).toBeGreaterThan("Client - Isomux".length);
    expect(iconShown()).not.toBe(icon);
    // The page sets a new title while on: the mark stays.
    document.title = "Inbox - Isomux";
    await flush();
    expect(document.title.endsWith("Inbox - Isomux")).toBe(true);
    expect(document.title.length).toBeGreaterThan("Inbox - Isomux".length);
    expect(changes).toBeGreaterThan(0);

    const img = host.querySelector("#img")!;
    gesture(img);
    expect(img.hasAttribute("data-recording-shown")).toBe(true);

    const before = changes;
    setRecording(false);
    expect(changes).toBeGreaterThan(before);
    expect(isRecording()).toBe(false);
    expect(currentRedactor()).toBe(null);
    expect(document.documentElement.hasAttribute("data-recording")).toBe(false);
    expect(host.querySelector("#p")!.textContent).toBe("Acme");
    expect(document.title).toBe("Inbox - Isomux");
    expect(iconShown()).toBe(icon);
    expect(img.hasAttribute("data-recording-shown")).toBe(false);
    // Off costs nothing: later text stays as written.
    const later = document.createElement("p");
    later.textContent = "Acme later";
    host.append(later);
    await flush();
    expect(later.textContent).toBe("Acme later");
    unsubscribe();
  });

  it("a rule change while on re-runs the page from its originals", () => {
    const host = mount(`<p id="p">Acme and Jo</p>`);
    setRecordingRules(RULES);
    setRecording(true);
    expect(host.querySelector("#p")!.textContent).toBe("Client and Jo");
    setRecordingRules({
      ...RULES,
      words: [{ word: "Jo", standIn: "Sam" }],
    });
    expect(host.querySelector("#p")!.textContent).toBe("Acme and Sam");
  });

  it("boot reads the flag before the first render, and another tab's switch follows", () => {
    setRecordingRules(RULES);
    localStorage.setItem(RECORDING_STORAGE_KEY, "1");
    const host = mount(`<p id="p">Acme</p>`);
    startRecordingMode();
    expect(isRecording()).toBe(true);
    expect(host.querySelector("#p")!.textContent).toBe("Client");

    // Another tab turns it off, then on again.
    const fromOtherTab = (newValue: string | null) => {
      if (newValue === null) localStorage.removeItem(RECORDING_STORAGE_KEY);
      else localStorage.setItem(RECORDING_STORAGE_KEY, newValue);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: RECORDING_STORAGE_KEY,
          oldValue: null,
          newValue,
          storageArea: localStorage,
        }),
      );
    };
    fromOtherTab(null);
    expect(isRecording()).toBe(false);
    expect(host.querySelector("#p")!.textContent).toBe("Acme");
    fromOtherTab(localStorage.getItem(RECORDING_STORAGE_KEY) ?? "1");
    expect(isRecording()).toBe(true);
    expect(host.querySelector("#p")!.textContent).toBe("Client");
  });
});

// The ride goes to another origin, with its own localStorage: the flag rides
// in the address. The login page keeps only the isomux-panel part of it
// (server/auth-middleware.ts PANEL_KEEP_SCRIPT), so a flag elsewhere in the
// address is lost on a ride that needs a sign-in.
describe("the elevator ride", () => {
  const HERE = "https://a.example.com";
  // holdArrivingPanel keeps the panel in module state until a sync: drain
  // it, so the next file in this process does not merge it.
  afterEach(() => {
    syncPanel([]);
    localStorage.clear();
  });

  // Leaves this office with the mode as given; arrives at a fresh office
  // (empty storage, mode off unless `arrivingOn`).
  function ride(on: boolean, arrivingOn: boolean, viaLogin: boolean) {
    setRecording(on);
    const fragment = rideFragment(HERE, []);
    setRecording(false);
    localStorage.clear();
    if (arrivingOn) localStorage.setItem(RECORDING_STORAGE_KEY, "1");
    if (viaLogin) {
      const part = fragment
        .split("&")
        .find((p) => p.startsWith(`${PANEL_HASH_KEY}=`))!;
      sessionStorage.setItem(PANEL_SESSION_KEY, part);
      history.replaceState(null, "", "/");
    } else {
      history.replaceState(null, "", `/#${fragment}`);
    }
    // ui/index.tsx order: the ride first, then the boot.
    expect(holdArrivingPanel()).toBe(true);
    startRecordingMode();
    return isRecording();
  }

  it("carries on to the next office, also through its sign-in page", () => {
    expect(ride(true, false, false)).toBe(true);
    expect(ride(true, false, true)).toBe(true);
  });

  it("never carries off, and never turns it on by itself", () => {
    expect(ride(false, false, false)).toBe(false);
    expect(ride(false, true, false)).toBe(true);
  });
});
