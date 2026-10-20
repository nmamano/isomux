// A server-written line or choice card is worded in the READER's language
// when the UI shows it (task c37a7365): the entry stores English in
// `content` and the keys in `message`. A language switch re-words lines
// already on screen, and a message the UI cannot read shows the stored
// English for the whole line or card, never a mix.
//
// Expected text comes from the catalog engine; `differs` proves a Spanish
// expectation is not the English one (testing guide, principle 15).

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render, fireEvent } = await import("@testing-library/react");
const { LogEntryCard } = await import("./LogEntryCard.tsx");
const { ChoiceInteractionCard } = await import("./LogView.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { translatorFor } = await import("../../shared/i18n/translate.ts");
const { msg } = await import("../../shared/i18n/log-message.ts");

import type { AgentChoiceInteraction, LogEntry } from "../../shared/types.ts";

const en = translatorFor("en");
const es = translatorFor("es");

function differs(spanish: string, english: string): string {
  expect(spanish).not.toBe(english);
  return spanish;
}

const switched = () =>
  en.t("systemEntries.effortSwitched", { label: en.t("common.effort.high") });
const switchedEs = () =>
  differs(
    es.t("systemEntries.effortSwitched", { label: es.t("common.effort.high") }),
    switched(),
  );

function entry(kind: "system" | "error", message: unknown): LogEntry {
  return {
    id: "e1",
    agentId: "agent",
    timestamp: 0,
    kind,
    content: switched(),
    message: message as LogEntry["message"],
  };
}

const goodMessage = () => [
  msg("systemEntries.effortSwitched", { label: msg("common.effort.high") }),
];

describe("a log entry with a message", () => {
  it("shows a system line in the reader's language, and re-words it on a language switch", () => {
    const e = entry("system", goodMessage());
    const view = render(onLanguage("es", <LogEntryCard entry={e} />));
    expect(view.container.textContent).toBe(switchedEs());
    view.rerender(onLanguage("en", <LogEntryCard entry={e} />));
    expect(view.container.textContent).toBe(switched());
    view.unmount();
  });

  it("shows an error line in the reader's language", () => {
    const view = render(
      onLanguage("es", <LogEntryCard entry={entry("error", goodMessage())} />),
    );
    expect(view.container.textContent).toContain(switchedEs());
    expect(view.container.textContent).not.toContain(switched());
    view.unmount();
  });

  it("shows the stored English for the whole line when the message is unreadable", () => {
    // A valid part next to one from a later release whose key this UI does
    // not know.
    const bad = [...goodMessage(), { key: "systemEntries.fromTheFuture" }];
    const view = render(
      onLanguage("es", <LogEntryCard entry={entry("system", bad)} />),
    );
    expect(view.container.textContent).toBe(switched());
    view.unmount();
  });
});

describe("a choice card with a message", () => {
  function card(over: Partial<AgentChoiceInteraction> = {}) {
    const interaction: AgentChoiceInteraction = {
      id: "i1",
      agentId: "agent",
      kind: "effort",
      title: en.t("choices.effort.title"),
      instruction: en.t("choices.model.instruction"),
      message: {
        title: [msg("choices.effort.title")],
        instruction: [msg("choices.model.instruction")],
      },
      choices: [
        {
          value: "high",
          label: en.t("common.effort.high"),
          description: en.t("common.effort.low"),
          message: {
            label: [msg("common.effort.high")],
            description: [msg("common.effort.low")],
          },
        },
        // A label that is data, not catalog text: no message, shown as is.
        { value: "claude-x", label: "claude-x-2026" },
      ],
      ...over,
    };
    return render(
      onLanguage("es", <ChoiceInteractionCard interaction={interaction} />),
    );
  }

  it("words the title, instruction, labels and descriptions for the reader", () => {
    const view = card();
    const text = view.container.textContent ?? "";
    const spanish = [
      differs(es.t("choices.effort.title"), en.t("choices.effort.title")),
      differs(
        es.t("choices.model.instruction"),
        en.t("choices.model.instruction"),
      ),
      differs(es.t("common.effort.high"), en.t("common.effort.high")),
      differs(es.t("common.effort.low"), en.t("common.effort.low")),
      "claude-x-2026",
    ];
    for (const s of spanish) expect(text).toContain(s);
    for (const key of [
      "choices.effort.title",
      "choices.model.instruction",
    ] as const)
      expect(text).not.toContain(en.t(key));
    // The card's accessible name is the worded title too.
    expect(
      view.container.querySelector("section")?.getAttribute("aria-label"),
    ).toBe(es.t("choices.effort.title"));
    view.unmount();
  });

  it("shows the whole card in English when one field's message is unreadable", () => {
    const view = card({
      message: {
        title: [msg("choices.effort.title")],
        instruction: [{ key: "choices.fromTheFuture" } as never],
      },
    });
    const text = view.container.textContent ?? "";
    for (const key of [
      "choices.effort.title",
      "choices.model.instruction",
      "common.effort.high",
      "common.effort.low",
    ] as const) {
      expect(text).toContain(en.t(key));
      expect(text).not.toContain(es.t(key));
    }
    view.unmount();
  });
});

// /help keeps its body in metadata: helpContent in English, and the parts in
// helpContentMessage (task c37a7365, slice 2). The help dialog shows the body
// in the reader's language, or the English body whole when the parts are
// unreadable.
describe("the /help body with a message", () => {
  const body = () => [
    msg("systemEntries.effortCancelled"),
    "\n\n",
    msg("systemEntries.modelCancelled"),
  ];
  const englishBody = () =>
    `${en.t("systemEntries.effortCancelled")}\n\n${en.t("systemEntries.modelCancelled")}`;

  function openHelp(helpContentMessage: unknown) {
    const help: LogEntry = {
      id: "help",
      agentId: "agent",
      timestamp: 0,
      kind: "system",
      content: en.t("commands.help.header"),
      message: [msg("commands.help.header")],
      metadata: { helpContent: englishBody(), helpContentMessage },
    };
    const view = render(onLanguage("es", <LogEntryCard entry={help} />));
    fireEvent.click(
      view.getByRole("button", { name: es.t("dialogs.agent.showHelp") }),
    );
    return view;
  }

  it("shows the help body in the reader's language", () => {
    const view = openHelp(body());
    const text = view.getByRole("dialog").textContent ?? "";
    expect(text).toContain(
      differs(
        es.t("systemEntries.effortCancelled"),
        en.t("systemEntries.effortCancelled"),
      ),
    );
    expect(text).toContain(es.t("systemEntries.modelCancelled"));
    expect(text).not.toContain(en.t("systemEntries.effortCancelled"));
    view.unmount();
  });

  it("shows the English body whole when the parts are unreadable", () => {
    const view = openHelp([...body(), { key: "commands.help.fromTheFuture" }]);
    const text = view.getByRole("dialog").textContent ?? "";
    expect(text).toContain(en.t("systemEntries.effortCancelled"));
    expect(text).toContain(en.t("systemEntries.modelCancelled"));
    expect(text).not.toContain(es.t("systemEntries.effortCancelled"));
    view.unmount();
  });
});
