// The SKILL.md text on the Skills page: CodeMirror with markdown highlighting,
// read-only until the member presses Edit. The editor grows with its text and
// the page scrolls, so a long skill reads like a document.

import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { useTheme } from "../store.tsx";

// Light-mode markdown colours from the theme variables. The default style
// underlines headings, and a SKILL.md frontmatter block parses as one, so the
// whole header read as a link.
const lightHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading, fontWeight: "700", color: "var(--accent-text)" },
    {
      tag: [tags.processingInstruction, tags.contentSeparator, tags.meta],
      color: "var(--text-muted)",
    },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "700" },
    { tag: [tags.monospace, tags.literal], color: "var(--hljs-string)" },
    { tag: [tags.link, tags.url], color: "var(--hljs-keyword)" },
    { tag: tags.quote, color: "var(--text-secondary)" },
    { tag: tags.list, color: "var(--hljs-number)" },
  ]),
);

export function SkillSourceEditor({
  value,
  editable,
  onChange,
  onSave,
  mobile,
}: {
  value: string;
  editable: boolean;
  onChange?: (text: string) => void;
  onSave?: () => void;
  mobile: boolean;
}) {
  const { mode } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeRef = useRef(new Compartment());
  const editRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...(mobile ? [] : [lineNumbers()]),
          highlightActiveLine(),
          history(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          markdown(),
          EditorView.theme({
            "&": { fontSize: "12.5px" },
            ".cm-content": {
              fontFamily: "'JetBrains Mono',monospace",
              padding: "10px 0",
            },
            ".cm-gutters": { fontFamily: "'JetBrains Mono',monospace" },
            "&.cm-focused": { outline: "none" },
          }),
          EditorView.contentAttributes.of({
            autocorrect: "off",
            autocapitalize: "off",
            spellcheck: "false",
          }),
          themeRef.current.of(mode === "dark" ? oneDark : lightHighlight),
          editRef.current.of([
            EditorState.readOnly.of(!editable),
            EditorView.editable.of(editable),
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The view is built once; the effects below keep it in step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editRef.current.reconfigure([
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ]),
    });
    if (editable) view.focus();
  }, [editable]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(
        mode === "dark" ? oneDark : lightHighlight,
      ),
    });
  }, [mode]);

  return (
    <div
      ref={hostRef}
      data-skill-source=""
      data-editable={editable ? "true" : "false"}
      style={{
        border: `1px solid ${editable ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--bg-code-block)",
        boxShadow: editable ? "0 0 0 3px var(--accent-bg)" : undefined,
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
    />
  );
}
