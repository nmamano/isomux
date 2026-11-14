// Escape closes the lightbox and only the lightbox (task 3d947224). Pages and
// dialogs close themselves on Escape from a capture listener on window, added
// when they mount; the lightbox opens later, above them. Escape while it is
// open must leave the page open, and the next Escape closes the page as
// before. The pages here are real ones that show chat text: a schedule run's
// log and the system prompt dialog.

import { afterAll, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { claimEscape } = await import("./escape-layer.ts");
const { LinkedImageLightbox } =
  await import("./log-view/attachment-download.tsx");
const { CronjobRunView } = await import("./components/CronjobRunView.tsx");
const { SystemPromptButton } =
  await import("./components/SystemPromptButton.tsx");
const { StateCtx, initialState } = await import("./store.tsx");
const { setApiShim } = await import("./api.ts");
const { en } = await import("../shared/i18n/en.ts");
const { cronjobRunStreamId } = await import("../shared/types.ts");
type CronjobRun = import("../shared/types.ts").CronjobRun;
type CronjobListWire = import("../shared/types.ts").CronjobListWire;

setApiShim(async () => ({}));
afterAll(() => setApiShim(null));

const IMAGE_PATH = "/api/files/agent-1/r11-walkthrough.png";
const TEXT = `Done. [open image full screen](${IMAGE_PATH})`;

// The lightbox's image: an img with the link's file, outside chat text.
const lightboxOpen = () =>
  [...document.body.querySelectorAll("img")].filter(
    (img) =>
      !img.closest(".md-content") &&
      (img.getAttribute("src") ?? "").includes(IMAGE_PATH),
  ).length;

function escape() {
  // Where focus is after a click on a link that did not navigate.
  fireEvent.keyDown(document.body, { key: "Escape" });
}

function imageLink(root: ParentNode): HTMLAnchorElement {
  const link = root.querySelector<HTMLAnchorElement>(
    `.md-content a[href="${IMAGE_PATH}"]`,
  );
  if (!link) throw new Error("the chat text has no image link");
  return link;
}

describe("Escape over a page", () => {
  it("a schedule run's log: Escape closes the lightbox, the run view stays, the next Escape closes it", () => {
    const run = {
      id: "run1",
      cronjobId: "job1",
      cronjobName: "Nightly",
      trigger: "manual",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
      errorReason: null,
      promptSnapshot: "p",
      agentTypeSnapshot: "claude",
      modelFamilySnapshot: "opus",
      effortSnapshot: "medium",
      cwdSnapshot: "~",
      permissionModeSnapshot: "bypassPermissions",
      rootSessionId: "sess-1",
      previewText: "",
    } as unknown as CronjobRun;
    const state = {
      ...initialState,
      // Nothing hydrated: the view does not fetch the transcript.
      hydrationEpoch: 0,
      cronjobs: [{ id: run.cronjobId, canManage: false } as CronjobListWire],
      cronjobRunsByJob: new Map([[run.cronjobId, [run]]]),
      logs: new Map([
        [
          cronjobRunStreamId(run.id),
          [
            {
              id: "e1",
              agentId: "agent-1",
              kind: "text" as const,
              content: TEXT,
              timestamp: 1,
            },
          ],
        ],
      ]),
    } as unknown as typeof initialState;
    let closes = 0;
    const view = render(
      <StateCtx.Provider value={state}>
        <LinkedImageLightbox />
        <CronjobRunView
          jobId={run.cronjobId}
          runId={run.id}
          onClose={() => closes++}
        />
      </StateCtx.Provider>,
    );
    fireEvent.click(imageLink(view.container));
    expect(lightboxOpen()).toBe(1);

    escape();
    expect(lightboxOpen()).toBe(0);
    expect(closes).toBe(0);

    escape();
    expect(closes).toBe(1);
    view.unmount();
  });

  it("the system prompt dialog: Escape closes the lightbox, the dialog stays, the next Escape closes it", async () => {
    const view = render(
      <>
        <LinkedImageLightbox />
        <SystemPromptButton helpContent={TEXT} />
      </>,
    );
    await act(async () => {
      fireEvent.click(
        view.getByRole("button", { name: en["dialogs.agent.showHelp"] }),
      );
      await Promise.resolve();
    });
    const dialogOpen = () =>
      document.body.querySelector(`.md-content a[href="${IMAGE_PATH}"]`) !==
      null;
    expect(dialogOpen()).toBe(true);
    fireEvent.click(imageLink(document.body));
    expect(lightboxOpen()).toBe(1);

    escape();
    expect(lightboxOpen()).toBe(0);
    expect(dialogOpen()).toBe(true);

    escape();
    expect(dialogOpen()).toBe(false);
    view.unmount();
  });
});

describe("claimEscape", () => {
  // A page's own listener, added before any claim, as a mounted page's is.
  function page() {
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") seen.push("page");
    };
    window.addEventListener("keydown", onKey, true);
    return {
      seen,
      done: () => window.removeEventListener("keydown", onKey, true),
    };
  }

  it("closes only the latest claim, and the page sees no Escape while one is held", () => {
    const p = page();
    const closed: string[] = [];
    const releaseA = claimEscape(() => closed.push("a"));
    const releaseB = claimEscape(() => closed.push("b"));
    escape();
    expect(closed).toEqual(["b"]);
    expect(p.seen).toEqual([]);
    releaseB();
    escape();
    expect(closed).toEqual(["b", "a"]);
    expect(p.seen).toEqual([]);
    releaseA();
    escape();
    expect(closed).toEqual(["b", "a"]);
    expect(p.seen).toEqual(["page"]);
    p.done();
  });

  it("a release removes its own claim, wherever it sits", () => {
    const closed: string[] = [];
    const releaseA = claimEscape(() => closed.push("a"));
    const releaseB = claimEscape(() => closed.push("b"));
    // The lower claim goes first: the top one still closes.
    releaseA();
    escape();
    expect(closed).toEqual(["b"]);
    // A second call of a release removes nothing else.
    releaseA();
    const releaseC = claimEscape(() => closed.push("c"));
    releaseA();
    escape();
    expect(closed).toEqual(["b", "c"]);
    releaseC();
    escape();
    expect(closed).toEqual(["b", "c", "b"]);
    releaseB();
  });

  it("is listening as soon as the module loads, before any page mounts", async () => {
    // A second copy of the module, loaded now: on the office page it is the
    // first import, so no reset between test files ever runs for it there.
    const spec = "./escape-layer.ts?first-import";
    const fresh = (await import(spec)) as typeof import("./escape-layer.ts");
    const p = page();
    const closed: string[] = [];
    const release = fresh.claimEscape(() => closed.push("overlay"));
    escape();
    expect(closed).toEqual(["overlay"]);
    expect(p.seen).toEqual([]);
    release();
    p.done();
  });

  it("leaves other keys to the page", () => {
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onKey, true);
    const release = claimEscape(() => {});
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(seen).toEqual(["Enter"]);
    release();
    window.removeEventListener("keydown", onKey, true);
  });
});
