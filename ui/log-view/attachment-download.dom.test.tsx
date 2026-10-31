// The chat's download control (task 00b49489): every image card, file chip and
// the lightbox carry a link that saves the file under its original name, on
// both copies of the attachment UI (FileViewCard, and AttachmentDisplay through
// UserMessage in the agent chat and the members chat). An image card shows its
// link only once the image has loaded or failed (task b1252974); happy-dom
// loads no image, so each test fires the event itself.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { FileViewCard } = await import("./FileViewCard.tsx");
const { UserMessage } = await import("./LogEntryCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { asDevice, IPHONE_HOME_SCREEN, stubShareSheet } =
  await import("../test-support/ios-home-screen.ts");
const { resetHomeScreenDownloadCache } =
  await import("../home-screen-download.ts");

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

function loadImages(root: ParentNode) {
  for (const img of root.querySelectorAll("img")) fireEvent.load(img);
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
      loadImages(root);

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

// Task b1252974: on a chat with many images, buttons that showed before their
// images sat outside the layout. The image card's link comes with the image:
// on load, and on error too, since the link is then the only way to get a
// file the browser cannot draw.
describe("chat attachments: the image card's download link waits for the image", () => {
  for (const c of cases) {
    for (const settle of ["load", "error"] as const) {
      it(`${c.name}: no link before the image settles, the link after ${settle}`, () => {
        const view = render(onLanguage("en", c.mount()));
        const root = view.container;
        const imageLink = () =>
          downloadLinks(root).find(
            (l) => l.getAttribute("download") === IMAGE.originalName,
          );

        // The card and the chip are there; only the image's link waits.
        const img = root.querySelector("img");
        expect(img).not.toBeNull();
        expect(
          downloadLinks(root).map((l) => l.getAttribute("download")),
        ).toEqual([FILE.originalName]);

        if (settle === "load") fireEvent.load(img!);
        else fireEvent.error(img!);
        expect(imageLink()).toBeDefined();
        expectDownloadOf(imageLink()!, c.base, IMAGE);
        expect(downloadLinks(root)).toHaveLength(2);
        view.unmount();
      });
    }
  }
});

// Task 3f5b8f33: the read-file card (and the ask card, which renders its
// readFiles through it) plays video and audio inline, and still offers the
// file chip and its download for each.
describe("FileViewCard: video and audio play inline", () => {
  const VIDEO = {
    filename: "short_1.mp4",
    originalName: "Daily short.mp4",
    mediaType: "video/mp4",
    size: 2638537,
  };
  const AUDIO = {
    filename: "voice_1.mp3",
    originalName: "Voice over.mp3",
    mediaType: "audio/mpeg",
    size: 4200,
  };
  const OTHER = {
    filename: "data_1.bin",
    originalName: "data.bin",
    mediaType: "application/octet-stream",
    size: 10,
  };
  const base = "/api/files/agent-1";
  const pathOf = (url: string | null) =>
    new URL(url ?? "", "http://office.test").pathname;

  for (const isMobile of [false, true]) {
    it(`${isMobile ? "phone" : "desktop"}: a player for each video and audio file, a chip and a download for each file`, () => {
      const view = render(
        onLanguage(
          "en",
          <FileViewCard
            attachments={[IMAGE, VIDEO, AUDIO, OTHER]}
            agentId="agent-1"
            isMobile={isMobile}
          />,
        ),
      );
      const root = view.container;
      loadImages(root);

      // One player per media file, on the file route, with controls. The
      // video plays in the page on an iPhone, not only in fullscreen.
      const videos = [...root.querySelectorAll("video")];
      expect(videos.map((v) => pathOf(v.getAttribute("src")))).toEqual([
        `${base}/${VIDEO.filename}`,
      ]);
      expect(videos[0].hasAttribute("controls")).toBe(true);
      expect(videos[0].hasAttribute("playsinline")).toBe(true);
      const audios = [...root.querySelectorAll("audio")];
      expect(audios.map((a) => pathOf(a.getAttribute("src")))).toEqual([
        `${base}/${AUDIO.filename}`,
      ]);
      expect(audios[0].hasAttribute("controls")).toBe(true);

      // The image stays an image; nothing else becomes one.
      expect(
        [...root.querySelectorAll("img")].map((i) => pathOf(i.src)),
      ).toEqual([`${base}/${IMAGE.filename}`]);

      // Each non-image file keeps its chip (name, opens in a new tab), and
      // every attachment keeps its download.
      const chips = [
        ...root.querySelectorAll<HTMLAnchorElement>(
          'a[target="_blank"]:not([download])',
        ),
      ];
      expect(
        chips.map((c) => [pathOf(c.getAttribute("href")), c.textContent]),
      ).toEqual(
        [VIDEO, AUDIO, OTHER].map((a) => [
          `${base}/${a.filename}`,
          expect.stringContaining(a.originalName),
        ]),
      );
      const links = downloadLinks(root);
      expect(links).toHaveLength(4);
      const byName = new Map(links.map((l) => [l.getAttribute("download"), l]));
      for (const att of [IMAGE, VIDEO, AUDIO, OTHER])
        expectDownloadOf(byName.get(att.originalName)!, base, att);
      view.unmount();
    });
  }
});

// Task f8d05b49: on the iPhone Home Screen office a download link opened the
// iOS file preview, which has no way back. There a tap on the download button
// stays in the office: it fetches the file (the plain file route; the name
// comes from the button) and opens the share sheet. iPhone Safari keeps the
// link's own download.
describe("chat attachments: download on an iPhone", () => {
  const base = "/api/files/agent-1";
  for (const [label, device, homeScreen] of [
    ["Home Screen office", IPHONE_HOME_SCREEN, true],
    ["Safari", { ...IPHONE_HOME_SCREEN, standalone: false }, false],
  ] as const) {
    it(`${label}: ${homeScreen ? "each download button opens the share sheet" : "the link downloads"}`, async () => {
      resetHomeScreenDownloadCache();
      const undoDevice = asDevice(device);
      const sheet = stubShareSheet();
      const view = render(
        onLanguage(
          "en",
          <FileViewCard attachments={[IMAGE, FILE]} agentId="agent-1" />,
        ),
      );
      const root = view.container;
      // Read after the button's own handler (React listens on the root),
      // then stop happy-dom from following the link.
      const prevented: boolean[] = [];
      const record = (e: Event) => {
        prevented.push(e.defaultPrevented);
        e.preventDefault();
      };
      root.addEventListener("click", record);
      try {
        loadImages(root);
        const byName = new Map(
          downloadLinks(root).map((l) => [l.getAttribute("download"), l]),
        );
        for (const att of [IMAGE, FILE]) {
          fireEvent.click(byName.get(att.originalName)!);
          await act(async () => {
            for (let i = 0; i < 3; i++)
              await new Promise((r) => setTimeout(r, 0));
          });
        }
        expect(prevented).toEqual([homeScreen, homeScreen]);
        const paths = sheet.fetches.map(
          (f) => new URL(f, "http://office.test"),
        );
        expect(paths.map((u) => u.pathname)).toEqual(
          homeScreen ? [IMAGE, FILE].map((a) => `${base}/${a.filename}`) : [],
        );
        expect(paths.every((u) => !u.searchParams.has("download"))).toBe(true);
        expect(sheet.shares.map((s) => s.files?.map((f) => f.name))).toEqual(
          homeScreen ? [[IMAGE.originalName], [FILE.originalName]] : [],
        );
      } finally {
        root.removeEventListener("click", record);
        view.unmount();
        sheet.undo();
        undoDevice();
      }
    });
  }
});

// Task 9aeb2266: the page forbids pinch zoom (the office pinches on its own),
// so on a phone the lightbox was the only way to see an image and it could not
// zoom; on a desktop an image larger than the window never showed full size.
// The lightbox now zooms its own image. image-zoom.test.ts pins the numbers;
// these pin the gestures. A 1000 x 800 window gives a 900 x 668 box, so a
// 1170 x 390 image fits at 900 x 300: full size is 1.3x, a double-tap 2x.
describe("ImageLightbox: zoom", () => {
  const LARGE = { w: 1170, h: 390 };
  const FIT_W = 900;
  const happyDOM = (
    window as unknown as {
      happyDOM: { setViewport(v: { width: number; height: number }): void };
    }
  ).happyDOM;
  const wait = (ms: number) =>
    act(() => new Promise<void>((r) => setTimeout(r, ms)));
  // Past the 300 ms double-tap window.
  const TAP_WINDOW = 400;

  function openLightbox(natural: { w: number; h: number }) {
    happyDOM.setViewport({ width: 1000, height: 800 });
    const card = () =>
      onLanguage(
        "en",
        <FileViewCard attachments={[IMAGE]} agentId="agent-1" />,
      );
    const view = render(card());
    const root = view.container;
    loadImages(root);
    fireEvent.click(root.querySelector("img")!);
    const img = [...document.querySelectorAll("img")].find(
      (i) => !root.contains(i),
    )!;
    expect(img).toBeDefined();
    // happy-dom loads no image: give it the size a browser would read.
    Object.defineProperty(img, "naturalWidth", { value: natural.w });
    Object.defineProperty(img, "naturalHeight", { value: natural.h });
    Object.defineProperty(img, "complete", { value: true });
    fireEvent.load(img);
    let backdrop: HTMLElement = img;
    while (backdrop.parentElement !== document.body)
      backdrop = backdrop.parentElement!;
    return {
      img,
      backdrop,
      // A re-render from above, as a streaming chat sends.
      rerender: () => view.rerender(card()),
      isOpen: () => document.body.contains(img),
      width: () => parseFloat(img.style.width),
      done: () => {
        view.unmount();
        happyDOM.setViewport({ width: 1024, height: 768 });
      },
    };
  }

  // A mouse press on `down`, an optional move, the release on `up`, and the
  // click the browser then sends to their nearest common ancestor.
  function mousePress(
    down: Element,
    up: Element,
    click: Element,
    move: { dx: number; dy: number } = { dx: 0, dy: 0 },
  ) {
    const at = { clientX: 200, clientY: 200 };
    const to = { clientX: 200 + move.dx, clientY: 200 + move.dy };
    fireEvent.pointerDown(down, { ...at, pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(down, { ...at, button: 0 });
    if (move.dx || move.dy) {
      fireEvent.pointerMove(down, { ...to, pointerType: "mouse", buttons: 1 });
      fireEvent.mouseMove(down, { ...to, buttons: 1 });
    }
    fireEvent.pointerUp(up, { ...to, pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(up, { ...to, button: 0 });
    fireEvent.click(click, { ...to, button: 0 });
  }

  // One finger tap as a phone sends it: pointer and touch events, then the
  // compatibility mouse events and click unless touchend was prevented.
  function tap(target: Element, x = 300, y = 300) {
    const t = { identifier: 0, clientX: x, clientY: y, target };
    const at = { clientX: x, clientY: y };
    fireEvent.pointerDown(target, { ...at, pointerType: "touch" });
    fireEvent.touchStart(target, {
      touches: [t],
      targetTouches: [t],
      changedTouches: [t],
    });
    fireEvent.pointerUp(target, { ...at, pointerType: "touch" });
    const notPrevented = fireEvent.touchEnd(target, {
      touches: [],
      targetTouches: [],
      changedTouches: [t],
    });
    if (notPrevented) {
      fireEvent.mouseDown(target, at);
      fireEvent.mouseUp(target, at);
      fireEvent.click(target, at);
    }
  }

  it("desktop: a click shows a large image at full size, and a second click fits it again", () => {
    const lb = openLightbox(LARGE);
    try {
      expect(lb.width()).toBeCloseTo(FIT_W, 3);
      mousePress(lb.img, lb.img, lb.img);
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(LARGE.w, 3);
      // A drag pans the zoomed image; it is not a click.
      mousePress(lb.img, lb.img, lb.img, { dx: 60, dy: 40 });
      expect(lb.width()).toBeCloseTo(LARGE.w, 3);
      mousePress(lb.img, lb.img, lb.img);
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(FIT_W, 3);
    } finally {
      lb.done();
    }
  });

  it("desktop: a click on an image that already shows at full size closes it", () => {
    const lb = openLightbox({ w: 400, h: 300 });
    try {
      expect(lb.width()).toBeCloseTo(400, 3);
      mousePress(lb.img, lb.img, lb.img);
      expect(lb.isOpen()).toBe(false);
    } finally {
      lb.done();
    }
  });

  it("the backdrop and the close button close it; a press on the image released on the backdrop does not", () => {
    const viaBackdrop = openLightbox(LARGE);
    try {
      // The press starts on the image (a drag off it): it stays open.
      mousePress(viaBackdrop.img, viaBackdrop.backdrop, viaBackdrop.backdrop, {
        dx: 500,
        dy: 0,
      });
      expect(viaBackdrop.isOpen()).toBe(true);
      mousePress(
        viaBackdrop.backdrop,
        viaBackdrop.backdrop,
        viaBackdrop.backdrop,
      );
      expect(viaBackdrop.isOpen()).toBe(false);
    } finally {
      viaBackdrop.done();
    }

    const viaButton = openLightbox(LARGE);
    try {
      // Zoomed, the image covers most of a phone: the button still closes.
      mousePress(viaButton.img, viaButton.img, viaButton.img);
      expect(viaButton.width()).toBeCloseTo(LARGE.w, 3);
      const buttons = [...viaButton.backdrop.querySelectorAll("button")];
      expect(buttons).toHaveLength(1);
      expect(
        buttons[0].getAttribute("aria-label")?.length ?? 0,
      ).toBeGreaterThan(0);
      mousePress(buttons[0], buttons[0], buttons[0]);
      expect(viaButton.isOpen()).toBe(false);
    } finally {
      viaButton.done();
    }
  });

  it("touch: a single tap at fit closes once the double-tap window has passed, and does not zoom", async () => {
    const lb = openLightbox(LARGE);
    try {
      tap(lb.img);
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(FIT_W, 3);
      await wait(TAP_WINDOW);
      expect(lb.isOpen()).toBe(false);
    } finally {
      lb.done();
    }
  });

  it("touch: a double-tap zooms to 2x once, a single tap when zoomed does nothing, a double-tap fits again", async () => {
    const lb = openLightbox(LARGE);
    try {
      tap(lb.img, 300, 300);
      tap(lb.img, 305, 302);
      // One action for the two taps and the clicks the browser adds to them.
      expect(lb.width()).toBeCloseTo(FIT_W * 2, 3);
      await wait(TAP_WINDOW);
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(FIT_W * 2, 3);

      tap(lb.img);
      await wait(TAP_WINDOW);
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(FIT_W * 2, 3);

      tap(lb.img, 300, 300);
      tap(lb.img, 300, 300);
      expect(lb.width()).toBeCloseTo(FIT_W, 3);
      expect(lb.isOpen()).toBe(true);
    } finally {
      lb.done();
    }
  });

  it("touch: a two-finger pinch zooms by the change in finger distance, and the browser does not take it", () => {
    const lb = openLightbox(LARGE);
    try {
      const fingers = (gap: number) => [
        { identifier: 0, clientX: 400 - gap / 2, clientY: 300, target: lb.img },
        { identifier: 1, clientX: 400 + gap / 2, clientY: 300, target: lb.img },
      ];
      const start = fingers(100);
      fireEvent.touchStart(lb.img, {
        touches: start,
        targetTouches: start,
        changedTouches: start,
      });
      const spread = fingers(150);
      const notPrevented = fireEvent.touchMove(lb.img, {
        touches: spread,
        targetTouches: spread,
        changedTouches: spread,
      });
      expect(notPrevented).toBe(false);
      expect(lb.width()).toBeCloseTo(FIT_W * 1.5, 3);
      fireEvent.touchEnd(lb.img, {
        touches: [],
        targetTouches: [],
        changedTouches: spread,
      });
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(FIT_W * 1.5, 3);
    } finally {
      lb.done();
    }
  });

  // Two fingers at `gap` px apart about (400 + shift, 300).
  function twoFingers(target: Element, gap: number, shift = 0) {
    return [
      { identifier: 0, clientX: 400 + shift - gap / 2, clientY: 300, target },
      { identifier: 1, clientX: 400 + shift + gap / 2, clientY: 300, target },
    ];
  }

  it("touch: a pinch right after a tap, or a cancelled touch, does not close it", async () => {
    const lb = openLightbox(LARGE);
    try {
      // The system takes the touch (iOS sends touchcancel): not a tap.
      const t = { identifier: 0, clientX: 300, clientY: 300, target: lb.img };
      fireEvent.touchStart(lb.img, {
        touches: [t],
        targetTouches: [t],
        changedTouches: [t],
      });
      fireEvent.touchCancel(lb.img, {
        touches: [],
        targetTouches: [],
        changedTouches: [t],
      });
      await wait(TAP_WINDOW);
      expect(lb.isOpen()).toBe(true);

      // A tap, then a pinch inside the double-tap window: the pinch wins.
      tap(lb.img);
      const start = twoFingers(lb.img, 100);
      fireEvent.touchStart(lb.img, {
        touches: start,
        targetTouches: start,
        changedTouches: start,
      });
      const spread = twoFingers(lb.img, 150);
      fireEvent.touchMove(lb.img, {
        touches: spread,
        targetTouches: spread,
        changedTouches: spread,
      });
      await wait(TAP_WINDOW);
      expect(lb.isOpen()).toBe(true);
      expect(lb.width()).toBeCloseTo(FIT_W * 1.5, 3);
    } finally {
      lb.done();
    }
  });

  it("a re-render after a pinch keeps the scroll the member panned to", () => {
    const lb = openLightbox(LARGE);
    try {
      const viewport = lb.img.parentElement!;
      const start = twoFingers(lb.img, 100);
      fireEvent.touchStart(lb.img, {
        touches: start,
        targetTouches: start,
        changedTouches: start,
      });
      const spread = twoFingers(lb.img, 150);
      fireEvent.touchMove(lb.img, {
        touches: spread,
        targetTouches: spread,
        changedTouches: spread,
      });
      expect(lb.width()).toBeCloseTo(FIT_W * 1.5, 3);
      // The fingers move together: a pan at the same scale.
      const moved = twoFingers(lb.img, 150, -40);
      fireEvent.touchMove(lb.img, {
        touches: moved,
        targetTouches: moved,
        changedTouches: moved,
      });
      fireEvent.touchEnd(lb.img, {
        touches: [],
        targetTouches: [],
        changedTouches: moved,
      });
      // Then one finger scrolls natively, and the chat re-renders.
      viewport.scrollLeft = 3;
      viewport.scrollTop = 0;
      lb.rerender();
      expect(lb.width()).toBeCloseTo(FIT_W * 1.5, 3);
      expect(viewport.scrollLeft).toBe(3);
    } finally {
      lb.done();
    }
  });

  it("a window resize (a phone turned) fits the image to the new window", () => {
    const lb = openLightbox(LARGE);
    try {
      mousePress(lb.img, lb.img, lb.img);
      expect(lb.width()).toBeCloseTo(LARGE.w, 3);
      // 800 x 600: a 720 x 488 box, so 1170 x 390 fits at 720 x 240.
      act(() => happyDOM.setViewport({ width: 800, height: 600 }));
      expect(lb.width()).toBeCloseTo(720, 3);
      expect(lb.isOpen()).toBe(true);
    } finally {
      lb.done();
    }
  });
});
