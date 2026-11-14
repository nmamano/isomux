// Images open in the lightbox, not as pages on the office's own host (task
// 3d947224). The browser keeps one zoom per host: a member who opened an
// agent's image link, zoomed it and closed the tab found the office zoomed
// too. A plain click on such a link, or on an image in chat text, opens the
// in-app lightbox, which zooms its own image. A click with a modifier is the
// member's own choice of a new tab or window and keeps the browser default.
// The DOM origin is http://localhost/ (ui/test-support/dom.ts).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { fireEvent, render } = await import("@testing-library/react");
const { lightboxForClick } = await import("./linked-image.ts");
const { LinkedImageLightbox, downloadHref } =
  await import("./attachment-download.tsx");
const { Markdown } = await import("./Markdown.tsx");
const { FileViewCard } = await import("./FileViewCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");

type ClickLike = Parameters<typeof lightboxForClick>[0];

const BASE = "http://localhost/";

function plainClick(target: EventTarget | null): ClickLike {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target,
  };
}

// A detached fragment of chat HTML; returns the element marked data-t.
function chatHtml(html: string, inText = true): HTMLElement {
  const host = document.createElement("div");
  if (inText) host.className = "md-content";
  host.innerHTML = html;
  const el = host.querySelector<HTMLElement>("[data-t]");
  if (!el) throw new Error("fixture has no data-t element");
  return el;
}

const pathOf = (src: string) => {
  const url = new URL(src, BASE);
  return url.pathname + url.search;
};

describe("lightboxForClick", () => {
  it("opens an image link on the office's host, from a click anywhere in the link", () => {
    const onLink = lightboxForClick(
      plainClick(chatHtml('<a data-t href="/api/files/a/shot.png">open</a>')),
      BASE,
    );
    expect(onLink && pathOf(onLink.src)).toBe("/api/files/a/shot.png");
    expect(onLink?.name).toBe("shot.png");

    const inside = lightboxForClick(
      plainClick(
        chatHtml(
          '<a href="/api/files/a/Shot%20one.png"><b><i data-t>open</i></b></a>',
        ),
      ),
      BASE,
    );
    expect(inside && pathOf(inside.src)).toBe("/api/files/a/Shot%20one.png");
    // The name the download saves under: the decoded file name.
    expect(inside?.name).toBe("Shot one.png");
  });

  it("opens an image link outside chat text too (an ask, the members chat)", () => {
    const got = lightboxForClick(
      plainClick(chatHtml('<a data-t href="/api/files/a/x.webp">x</a>', false)),
      BASE,
    );
    expect(got && pathOf(got.src)).toBe("/api/files/a/x.webp");
  });

  it("keeps the browser default for a click with a modifier or another button", () => {
    const link = chatHtml('<a data-t href="/api/files/a/shot.png">open</a>');
    expect(lightboxForClick(plainClick(link), BASE)).not.toBeNull();
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)
      expect(
        lightboxForClick({ ...plainClick(link), [key]: true }, BASE),
      ).toBeNull();
    for (const button of [1, 2])
      expect(
        lightboxForClick({ ...plainClick(link), button }, BASE),
      ).toBeNull();
    expect(
      lightboxForClick({ ...plainClick(link), defaultPrevented: true }, BASE),
    ).toBeNull();
  });

  it("leaves a link with a download attribute to the download", () => {
    const link = chatHtml(
      '<a data-t href="/api/files/a/shot.png" download="shot.png">save</a>',
    );
    expect(lightboxForClick(plainClick(link), BASE)).toBeNull();
  });

  it("leaves links to other hosts and to other files to their pages", () => {
    for (const href of ["https://other.test/x.png", "/api/files/a/report.pdf"])
      expect(
        lightboxForClick(
          plainClick(chatHtml(`<a data-t href="${href}">x</a>`)),
          BASE,
        ),
      ).toBeNull();
  });

  it("opens an image in chat text that is not in a link", () => {
    const got = lightboxForClick(
      plainClick(
        chatHtml('<img data-t src="/api/files/a/chart.png" alt="Chart">'),
      ),
      BASE,
    );
    expect(got && pathOf(got.src)).toBe("/api/files/a/chart.png");
    expect(got?.name).toBe("chart.png");
  });

  it("leaves an image outside chat text alone: it has its own click, or none", () => {
    expect(
      lightboxForClick(
        plainClick(
          chatHtml('<img data-t src="/api/files/a/chart.png">', false),
        ),
        BASE,
      ),
    ).toBeNull();
  });

  it("lets the link decide for an image inside a link", () => {
    // A link to a page: the page opens, not the image.
    for (const href of ["https://example.com/", "/api/files/a/report.pdf"])
      expect(
        lightboxForClick(
          plainClick(
            chatHtml(
              `<a href="${href}"><img data-t src="/api/files/a/t.png"></a>`,
            ),
          ),
          BASE,
        ),
      ).toBeNull();
    // A thumbnail that links to the full image: the full image opens.
    const full = lightboxForClick(
      plainClick(
        chatHtml(
          '<a href="/api/files/a/full.png"><img data-t src="/api/files/a/thumb.png"></a>',
        ),
      ),
      BASE,
    );
    expect(full && pathOf(full.src)).toBe("/api/files/a/full.png");
  });

  it("names a file whose name is not valid percent-encoding by its raw name", () => {
    const got = lightboxForClick(
      plainClick(chatHtml('<a data-t href="/api/files/a/100%.png">x</a>')),
      BASE,
    );
    expect(got).not.toBeNull();
    expect(got!.name).toBe("100%.png");
  });

  it("does nothing for a click with no element target", () => {
    expect(lightboxForClick(plainClick(null), BASE)).toBeNull();
  });
});

describe("downloadHref", () => {
  it("adds the download name to a URL that already has a query", () => {
    const url = new URL(
      downloadHref("/api/files/a/x.png?v=2", "Shot 1.png"),
      BASE,
    );
    expect(url.pathname).toBe("/api/files/a/x.png");
    expect(url.searchParams.get("v")).toBe("2");
    expect(url.searchParams.get("download")).toBe("Shot 1.png");
  });

  it("keeps a path on the office's host path-relative", () => {
    const href = downloadHref("/api/files/a/x.png", "x.png");
    expect(href.startsWith("/api/files/a/x.png?")).toBe(true);
    expect(new URL(href, BASE).searchParams.get("download")).toBe("x.png");
  });
});

// The lightbox opened on the page: its image, outside the rendered tree (a
// portal on document.body).
function lightboxImages(container: HTMLElement): HTMLImageElement[] {
  return [...document.body.querySelectorAll("img")].filter(
    (img) => !container.contains(img),
  );
}

// Whether the browser would follow the link: read at the window, after every
// listener on the way. The test then stops the navigation itself.
let followed: boolean[] = [];
function recordNavigation(e: Event) {
  if (e.type !== "click") return;
  followed.push(!e.defaultPrevented);
  e.preventDefault();
}
beforeEach(() => {
  followed = [];
  window.addEventListener("click", recordNavigation);
});
afterEach(() => {
  window.removeEventListener("click", recordNavigation);
});

const CHAT =
  "Done. [open image full screen](/api/files/agent-1/shot.png?v=2) and ![Chart](/api/files/agent-1/chart.png)";

function mountChat(wrap: (md: ReactElement) => ReactElement = (m) => m) {
  const view = render(
    onLanguage(
      "en",
      <>
        <LinkedImageLightbox />
        {wrap(<Markdown content={CHAT} />)}
      </>,
    ),
  );
  const link = view.container.querySelector<HTMLAnchorElement>(
    'a[href*="shot.png"]',
  );
  const img = view.container.querySelector<HTMLImageElement>(
    '.md-content img[src*="chart.png"]',
  );
  if (!link || !img) throw new Error("chat did not render the link and image");
  return { view, link, img };
}

describe("LinkedImageLightbox", () => {
  it("opens an agent's image link in the lightbox, not as a page", () => {
    const { view, link } = mountChat();
    fireEvent.click(link);
    expect(followed).toEqual([false]);
    const shown = lightboxImages(view.container);
    expect(shown.length).toBe(1);
    expect(pathOf(shown[0].getAttribute("src")!)).toBe(
      "/api/files/agent-1/shot.png?v=2",
    );
    // Its download saves the same file under its name.
    const save = [
      ...document.body.querySelectorAll<HTMLAnchorElement>("a[download]"),
    ].filter((a) => !view.container.contains(a));
    expect(save.length).toBe(1);
    const saveUrl = new URL(save[0].getAttribute("href")!, BASE);
    expect(saveUrl.pathname).toBe("/api/files/agent-1/shot.png");
    expect(saveUrl.searchParams.get("v")).toBe("2");
    expect(saveUrl.searchParams.get("download")).toBe("shot.png");
    expect(save[0].getAttribute("download")).toBe("shot.png");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(lightboxImages(view.container).length).toBe(0);
    view.unmount();
  });

  it("opens an image in the agent's text in the lightbox", () => {
    const { view, img } = mountChat();
    fireEvent.click(img);
    const shown = lightboxImages(view.container);
    expect(shown.length).toBe(1);
    expect(pathOf(shown[0].getAttribute("src")!)).toBe(
      "/api/files/agent-1/chart.png",
    );
    view.unmount();
  });

  it("keeps the browser's new tab for a ctrl-click and a cmd-click", () => {
    const { view, link } = mountChat();
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    expect(followed).toEqual([true, true]);
    expect(lightboxImages(view.container).length).toBe(0);
    view.unmount();
  });

  it("opens the lightbox under a view that stops clicks from bubbling", () => {
    // The click never reaches the window, so the view reads it and stops
    // the navigation itself.
    const prevented: boolean[] = [];
    const { view, link } = mountChat((md) => (
      <div
        onClick={(e) => {
          prevented.push(e.defaultPrevented);
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {md}
      </div>
    ));
    fireEvent.click(link);
    expect(prevented).toEqual([true]);
    expect(followed).toEqual([]);
    expect(lightboxImages(view.container).length).toBe(1);
    view.unmount();
  });

  it("opens one lightbox for an image card, which opens its own", () => {
    const view = render(
      onLanguage(
        "en",
        <>
          <LinkedImageLightbox />
          <FileViewCard
            attachments={[
              {
                filename: "shot_1.png",
                originalName: "shot.png",
                mediaType: "image/png",
                size: 1200,
              },
            ]}
            agentId="agent-1"
          />
        </>,
      ),
    );
    fireEvent.click(view.container.querySelector("img")!);
    expect(lightboxImages(view.container).length).toBe(1);
    view.unmount();
  });

  it("stops listening when it unmounts", () => {
    const { view, link } = mountChat();
    const lightbox = render(<LinkedImageLightbox />);
    lightbox.unmount();
    view.unmount();
    // A link left on the page after both are gone.
    document.body.appendChild(link);
    fireEvent.click(link);
    expect(followed).toEqual([true]);
    link.remove();
  });
});
