import { useContext, useMemo } from "react";
import { InlineMarkdown } from "../members-chat/InlineMarkdown.tsx";
import { useAppState } from "../store.tsx";
import { TaskOpener, type TaskMap } from "./task-links.tsx";
import {
  matchAskFile,
  splitAskPrompt,
  type DiffLine,
} from "./ask-prompt-diff.ts";
import { FileViewCard } from "./FileViewCard.tsx";
import type { AskReadFile } from "../../shared/types.ts";

// The chat diff card's colors (diff2html's variables, re-routed in dark mode
// under .d2h-isomux-host), with the light values for a page without its sheet.
const ROW = {
  removed: {
    marker: "-",
    line: "var(--d2h-del-bg-color, #fee8e9)",
    word: "var(--d2h-del-highlight-bg-color, #ffb6ba)",
  },
  added: {
    marker: "+",
    line: "var(--d2h-ins-bg-color, #dfd)",
    word: "var(--d2h-ins-highlight-bg-color, #97f295)",
  },
};

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "context")
    return (
      <div
        data-diff-line="context"
        // An empty line keeps its height.
        style={{ color: "var(--text-secondary)", minHeight: "1.5em" }}
      >
        {line.text}
      </div>
    );
  const row = ROW[line.kind];
  return (
    <div
      data-diff-line={line.kind}
      style={{
        background: row.line,
        // The marker hangs left of wrapped lines.
        paddingLeft: "1.4em",
        textIndent: "-1.1em",
      }}
    >
      <span style={{ display: "inline-block", width: "1.1em", textIndent: 0 }}>
        {row.marker}
      </span>
      {line.words
        ? line.words.map((w, i) =>
            w.changed ? (
              <span
                key={i}
                data-diff-word="changed"
                style={{ background: row.word, borderRadius: 2 }}
              >
                {w.text}
              </span>
            ) : (
              w.text
            ),
          )
        : line.text}
    </div>
  );
}

// An ask prompt: inline markdown, with each ```diff block drawn as a red and
// green diff, and each reference line as the read files it names, in the
// chat's file card. A name with no file, and every name where the surface
// passes no files, shows as the name. The ids of the tasks the member sees are
// chips, as in the chat. `srcFor` is where a file is served from; files come
// with it.
export function AskPrompt<T extends AskReadFile>({
  content,
  files,
  srcFor,
  isMobile,
}: {
  content: string;
  files?: readonly T[];
  srcFor?: (att: T) => string;
  isMobile?: boolean;
}) {
  const segments = useMemo(() => splitAskPrompt(content), [content]);
  const { tasks } = useAppState();
  const taskMap: TaskMap = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const openTask = useContext(TaskOpener) ?? undefined;
  return segments.map((segment, i) =>
    segment.kind === "files" ? (
      <PlacedFiles
        key={i}
        names={segment.names}
        files={srcFor ? (files ?? []) : []}
        srcFor={srcFor ?? (() => "")}
        isMobile={isMobile}
      />
    ) : segment.kind === "text" ? (
      <InlineMarkdown
        key={i}
        content={segment.text}
        code
        colors
        tasks={taskMap}
        onOpenTask={openTask}
      />
    ) : (
      <div
        key={i}
        data-ask-diff=""
        className="d2h-isomux-host"
        style={{
          margin: "4px 0",
          borderRadius: 4,
          overflow: "hidden",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: "var(--text-primary)",
        }}
      >
        {segment.lines.map((line, j) => (
          <DiffRow key={j} line={line} />
        ))}
      </div>
    ),
  );
}

// One reference row: each run of names with files is one file card, in order,
// and a name with no file is its own line. A run shows a file once.
function PlacedFiles<T extends AskReadFile>({
  names,
  files,
  srcFor,
  isMobile,
}: {
  names: string[];
  files: readonly T[];
  srcFor: (att: T) => string;
  isMobile?: boolean;
}) {
  const runs: (T[] | string)[] = [];
  for (const name of names) {
    const file = matchAskFile(name, files);
    const last = runs[runs.length - 1];
    if (!file) runs.push(name);
    else if (Array.isArray(last)) {
      if (!last.includes(file)) last.push(file);
    } else runs.push([file]);
  }
  return runs.map((run, i) =>
    typeof run === "string" ? (
      <div key={i} data-ask-file-name="">
        {run}
      </div>
    ) : (
      <FileViewCard
        key={i}
        attachments={run}
        // srcFor serves every file, so the agent's files dir is not used.
        agentId=""
        isMobile={isMobile}
        srcFor={srcFor}
      />
    ),
  );
}
