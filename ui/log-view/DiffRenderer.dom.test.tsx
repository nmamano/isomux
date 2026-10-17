import { expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { render } = await import("@testing-library/react");
const { DiffRenderer } = await import("./DiffRenderer.tsx");

const PATCH = [
  "diff --git a/a.svg b/a.svg",
  "--- a/a.svg",
  "+++ b/a.svg",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
  "",
].join("\n");

// The chat re-renders its whole transcript on every scroll, timer tick and
// state change. A diff whose HTML is written again on each of those renders
// made Safari drop the chat's scroll position by the diff's height, and the
// resulting scroll event caused the next render: the view flickered between
// the bottom and an older spot (task ffe82e3a).
it("keeps the rendered diff nodes across a re-render with the same patch", () => {
  const view = render(
    <DiffRenderer patchText={PATCH} outputFormat="line-by-line" />,
  );
  const host = view.container.querySelector(".d2h-isomux-host");
  expect(host?.querySelector(".d2h-diff-table") != null).toBe(true);
  host!.firstElementChild!.setAttribute("data-probe", "kept");

  view.rerender(<DiffRenderer patchText={PATCH} outputFormat="line-by-line" />);
  expect(host!.querySelector("[data-probe]") != null).toBe(true);
});

it("renders the new diff when the patch changes", () => {
  const view = render(
    <DiffRenderer patchText={PATCH} outputFormat="line-by-line" />,
  );
  const host = view.container.querySelector(".d2h-isomux-host")!;
  host.firstElementChild!.setAttribute("data-probe", "stale");

  view.rerender(
    <DiffRenderer
      patchText={PATCH.replace("+new", "+newer")}
      outputFormat="line-by-line"
    />,
  );
  expect(host.querySelector("[data-probe]") == null).toBe(true);
  expect(host.querySelector(".d2h-diff-table") != null).toBe(true);
});

it("renders the other layout when the output format changes", () => {
  const view = render(
    <DiffRenderer patchText={PATCH} outputFormat="line-by-line" />,
  );
  const host = view.container.querySelector(".d2h-isomux-host")!;
  expect(host.querySelector(".d2h-file-side-diff") == null).toBe(true);

  view.rerender(<DiffRenderer patchText={PATCH} outputFormat="side-by-side" />);
  expect(host.querySelector(".d2h-file-side-diff") != null).toBe(true);
});
