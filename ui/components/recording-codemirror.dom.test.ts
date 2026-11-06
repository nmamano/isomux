// Recording mode in a CodeMirror editor (task 6e08239a): the page-wide layer
// skips .cm-editor (a rewrite there would be saved), so this extension is
// the only thing that hides a match in the editor. It draws the stand-in
// over each match and leaves the document as it is, so a save writes the
// real text.

import { afterEach, describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { recordingRedaction } = await import("./recording-codemirror.ts");
const { setRecording, setRecordingRules } =
  await import("../recording-mode.ts");

type Redactor = import("../../shared/recording-redact.ts").Redactor;

const redact: Redactor = (text) => text.replace(/Acme/g, "Client");

const views: InstanceType<typeof EditorView>[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  setRecording(false);
  document.body.innerHTML = "";
});

function editor(doc: string, ext: ReturnType<typeof recordingRedaction>) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [ext] }),
    parent,
  });
  views.push(view);
  return view;
}

const shown = (view: InstanceType<typeof EditorView>) =>
  view.contentDOM.textContent ?? "";

describe("recordingRedaction", () => {
  it("draws the stand-in over each match and keeps the document", () => {
    const doc = "Hello Acme\nsecond line, Acme again";
    const view = editor(
      doc,
      recordingRedaction(() => redact),
    );
    expect(shown(view)).not.toContain("Acme");
    expect(shown(view)).toContain("Hello Client");
    expect(shown(view)).toContain("Client again");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("follows edits: a match typed later is hidden, and the document keeps it", () => {
    const view = editor(
      "plain",
      recordingRedaction(() => redact),
    );
    view.dispatch({ changes: { from: 0, insert: "Acme " } });
    expect(shown(view)).not.toContain("Acme");
    expect(view.state.doc.toString()).toBe("Acme plain");
  });

  it("draws the real text while the mode is off", () => {
    const view = editor(
      "Hello Acme",
      recordingRedaction(() => null),
    );
    expect(shown(view)).toContain("Hello Acme");
  });

  // An editor that is already open when the member turns the mode on, or
  // changes the words, redraws without a keystroke.
  it("by default follows recording mode: on, a rule change, and off", () => {
    setRecordingRules({
      officeHosts: [],
      otherOffices: [],
      words: [{ word: "Acme", standIn: "Client" }],
    });
    const doc = "Acme and Jo";
    const view = editor(doc, recordingRedaction());
    expect(shown(view)).toContain("Acme and Jo");

    setRecording(true);
    expect(shown(view)).not.toContain("Acme");
    expect(shown(view)).toContain("Client and Jo");

    setRecordingRules({
      officeHosts: [],
      otherOffices: [],
      words: [{ word: "Jo", standIn: "Sam" }],
    });
    expect(shown(view)).toContain("Acme and Sam");

    setRecording(false);
    expect(shown(view)).toContain("Acme and Jo");
    expect(view.state.doc.toString()).toBe(doc);
  });
});
