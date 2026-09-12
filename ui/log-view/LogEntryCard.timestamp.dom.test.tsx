import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

it("shows each user and assistant entry's server timestamp", () => {
  const timestamp = Date.UTC(2026, 8, 12, 12, 0);
  for (const kind of ["user_message", "text"] as const) {
    const view = render(
      onLanguage(
        "en",
        <LogEntryCard
          entry={{
            id: kind,
            agentId: "agent",
            timestamp,
            kind,
            content: "Message",
          }}
        />,
      ),
    );
    const time = view.container.querySelector("time[data-message-timestamp]");
    expect(time !== null).toBe(true);
    expect(time?.textContent).toMatch(/9\/12\/26/);
    expect(time?.getAttribute("title")).toBe("2026-09-12T12:00:00.000Z");
    expect(time?.getAttribute("datetime")).toBe("2026-09-12T12:00:00.000Z");
    view.unmount();
  }
});
