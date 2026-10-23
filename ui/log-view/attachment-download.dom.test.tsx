// The chat's download control (task 00b49489): every image card, file chip and
// the lightbox carry a link that saves the file under its original name, on
// both copies of the attachment UI (FileViewCard, and AttachmentDisplay through
// UserMessage in the agent chat and the members chat).

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render } = await import("@testing-library/react");
const { FileViewCard } = await import("./FileViewCard.tsx");
const { UserMessage } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

const IMAGE = {
  filename: "shot_1.png",
  originalName: "Screen shot 截图 #1.png",
  mediaType: "image/png",
  size: 1200,
};
const FILE = {
  filename: "report_v2.pdf",
  originalName: "Report v2 (final).pdf",
  mediaType: "application/pdf",
  size: 3400,
};

// happy-dom follows a clicked link; the browser's download is not under test.
const stopNavigation = (e: Event) => e.preventDefault();

function downloadLinks(root: ParentNode): HTMLAnchorElement[] {
  return [...root.querySelectorAll<HTMLAnchorElement>("a[download]")];
}

// The link saves `att` from `base`: same file path, the original name in both
// the download attribute and the ?download parameter the server reads.
function expectDownloadOf(
  link: HTMLAnchorElement,
  base: string,
  att: { filename: string; originalName: string },
) {
  const url = new URL(link.getAttribute("href")!, "http://office.test");
  expect(url.pathname).toBe(`${base}/${att.filename}`);
  expect(url.searchParams.get("download")).toBe(att.originalName);
  expect(link.getAttribute("download")).toBe(att.originalName);
  expect(link.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
}

const cases = [
  {
    name: "FileViewCard (read-file card)",
    base: "/api/files/agent-1",
    mount: () => <FileViewCard attachments={[IMAGE, FILE]} agentId="agent-1" />,
  },
  {
    name: "UserMessage in the agent chat",
    base: "/api/files/agent-1",
    mount: () => (
      <UserMessage
        content="see attached"
        attachments={[IMAGE, FILE]}
        agentId="agent-1"
      />
    ),
  },
  {
    name: "UserMessage in the members chat",
    base: "/api/members-chat/files",
    mount: () => (
      <UserMessage
        variant="members-chat"
        content="see attached"
        attachments={[IMAGE, FILE]}
        fileBase="/api/members-chat/files"
      />
    ),
  },
];

describe("chat attachments: download under the original name", () => {
  for (const c of cases) {
    it(`${c.name}: the image card, the file chip and the lightbox each download`, () => {
      document.addEventListener("click", stopNavigation, true);
      const view = render(onLanguage("en", c.mount()));
      const root = view.container;
      const imgCount = () => document.querySelectorAll("img").length;

      // One download link per attachment, on the card itself.
      const links = downloadLinks(root);
      expect(links).toHaveLength(2);
      const byName = new Map(links.map((l) => [l.getAttribute("download"), l]));
      expectDownloadOf(byName.get(IMAGE.originalName)!, c.base, IMAGE);
      expectDownloadOf(byName.get(FILE.originalName)!, c.base, FILE);

      // The chip still opens the file in a new tab, without the parameter.
      const opener = root.querySelector<HTMLAnchorElement>(
        'a[target="_blank"]:not([download])',
      );
      expect(opener).not.toBeNull();
      const openUrl = new URL(opener!.getAttribute("href")!, "http://o.test");
      expect(openUrl.pathname).toBe(`${c.base}/${FILE.filename}`);
      expect(openUrl.searchParams.has("download")).toBe(false);

      // The card's button downloads; it does not open the lightbox.
      expect(imgCount()).toBe(1);
      fireEvent.click(byName.get(IMAGE.originalName)!);
      expect(imgCount()).toBe(1);

      // The lightbox has its own download link for the open image, and a click
      // on it leaves the lightbox open.
      fireEvent.click(root.querySelector("img")!);
      expect(imgCount()).toBe(2);
      const all = downloadLinks(document);
      expect(all).toHaveLength(3);
      const lightboxLink = all.find((l) => !links.includes(l))!;
      expectDownloadOf(lightboxLink, c.base, IMAGE);
      fireEvent.click(lightboxLink);
      expect(imgCount()).toBe(2);

      // Escape still closes it.
      fireEvent.keyDown(window, { key: "Escape" });
      expect(imgCount()).toBe(1);
      view.unmount();
      document.removeEventListener("click", stopNavigation, true);
    });
  }
});
