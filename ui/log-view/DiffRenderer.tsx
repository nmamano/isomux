import { useMemo } from "react";
import { html as diff2htmlRender } from "diff2html";

export type DiffOutputFormat = "line-by-line" | "side-by-side";

// Thin wrapper around diff2html. The replaceable boundary that a future Tier A
// rewrite (hand-rolled React on Shiki tokens) would target without touching
// <DiffCard> consumers.
export function DiffRenderer({
  patchText,
  outputFormat,
  drawFileList = false,
}: {
  patchText: string;
  outputFormat: DiffOutputFormat;
  drawFileList?: boolean;
}) {
  // Memoize the dangerouslySetInnerHTML object, not only the string: React 19
  // rewrites innerHTML whenever the object changes, even to the same string.
  // A rewrite on every chat re-render made Safari drop the chat's scroll
  // position by the diff's height. Markdown.tsx avoids the same rewrite by
  // writing innerHTML in a layout effect keyed on the html.
  const html = useMemo(
    () => ({
      __html: diff2htmlRender(patchText, {
        outputFormat,
        drawFileList,
        matching: "lines",
        diffStyle: "word",
        renderNothingWhenEmpty: true,
      }),
    }),
    [patchText, outputFormat, drawFileList],
  );
  return <div className="d2h-isomux-host" dangerouslySetInnerHTML={html} />;
}
