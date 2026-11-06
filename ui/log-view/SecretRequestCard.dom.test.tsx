// A secret request card from a server before secret requests became asks:
// read-only, with its outcome from the transcript or else closed, and never a
// form, whoever views it.
import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";
setUpDomTestFile();
const { render } = await import("@testing-library/react");
const { SecretRequestCard, SecretRequestOutcomes } =
  await import("./SecretRequestCard.tsx");
const { StateCtx, initialState } = await import("../store.tsx");

const PAYLOAD = {
  requestId: "req-1",
  scope: "personal" as const,
  name: "GH_TOKEN",
  hosts: ["api.github.com"],
  form: { kind: "authorization" as const },
  reason: "To open the pull request.",
  bootId: "boot-1",
};

// The viewer is the agent's manager and an owner: the one who could answer
// it when it was open.
const STATE = {
  ...initialState,
  sessionContext: { userId: "u-alice", username: "alice", role: "owner" },
  agents: [{ id: "a1", userId: "u-alice" }],
} as unknown as typeof initialState;

function card(
  outcomes: Map<string, "saved" | "declined"> = new Map(),
  payload = PAYLOAD,
) {
  return render(
    <StateCtx.Provider value={STATE}>
      <SecretRequestOutcomes.Provider value={outcomes}>
        <SecretRequestCard payload={payload} />
      </SecretRequestOutcomes.Provider>
    </StateCtx.Provider>,
  );
}

const hasForm = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-masked-credential], textarea, button") !==
  null;
const outcome = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-outcome]")?.getAttribute("data-outcome");

it("shows the request and its outcome from the transcript, else closed, with no form", () => {
  for (const [settled, shown] of [
    ["saved", "saved"],
    ["declined", "declined"],
    [null, "closed"],
  ] as const) {
    const view = card(
      new Map<string, "saved" | "declined">(
        settled ? [["req-1", settled]] : [],
      ),
    );
    expect(view.container.textContent).toContain(PAYLOAD.reason);
    expect({ settled, outcome: outcome(view) }).toEqual({
      settled,
      outcome: shown,
    });
    expect(hasForm(view)).toBe(false);
    view.unmount();
  }
});

// The reason is agent text: a web URL in it opens in a new tab, as in an ask,
// and an unsafe link stays text.
it("a URL in the reason is a link that opens in a new tab; a javascript: link is not", () => {
  const url = "https://github.com/settings/tokens";
  const linked = `Make one at ${url} with repo scope.`;
  const view = card(new Map(), { ...PAYLOAD, reason: linked });
  expect(view.container.textContent).toContain(linked);
  expect(
    [...view.container.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href"),
      target: a.target,
      noopener: a.rel.split(" ").includes("noopener"),
    })),
  ).toEqual([{ href: url, target: "_blank", noopener: true }]);
  view.unmount();

  const unsafe = "Run [this](javascript:alert(1)) first.";
  const bad = card(new Map(), { ...PAYLOAD, reason: unsafe });
  expect(bad.container.querySelectorAll("a").length).toBe(0);
  expect(bad.container.textContent).toContain("javascript:alert(1)");
  bad.unmount();
});

// The reason draws colour markup as the secret ask's card does (task
// b2f055c6), so one request reads the same on both cards.
it("draws colour markup in the reason", () => {
  const view = card(new Map(), {
    ...PAYLOAD,
    reason: ":purple[**Quick action**] To open the pull request.",
  });
  const span = view.container.querySelector<HTMLElement>("[data-color]");
  expect({
    color: span?.dataset.color,
    bold: span?.querySelector("strong")?.textContent,
    raw: /:purple\[|\*\*/.test(view.container.textContent ?? ""),
  }).toEqual({ color: "purple", bold: "Quick action", raw: false });
  view.unmount();
});
