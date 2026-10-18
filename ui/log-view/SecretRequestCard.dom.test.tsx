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

function card(outcomes: Map<string, "saved" | "declined"> = new Map()) {
  return render(
    <StateCtx.Provider value={STATE}>
      <SecretRequestOutcomes.Provider value={outcomes}>
        <SecretRequestCard payload={PAYLOAD} />
      </SecretRequestOutcomes.Provider>
    </StateCtx.Provider>,
  );
}

const hasForm = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-masked-credential], textarea, button") !==
  null;
const outcome = (view: ReturnType<typeof render>) =>
  view.container.querySelector("[data-outcome]")?.getAttribute("data-outcome");

it("shows the request and its outcome from the transcript, with no form", () => {
  for (const settled of ["saved", "declined"] as const) {
    const view = card(new Map([["req-1", settled]]));
    expect(view.container.textContent).toContain(PAYLOAD.reason);
    expect(outcome(view)).toBe(settled);
    expect(hasForm(view)).toBe(false);
    view.unmount();
  }
});

it("an unsettled request shows closed, with no form", () => {
  const view = card();
  expect(outcome(view)).toBe("closed");
  expect(hasForm(view)).toBe(false);
});
