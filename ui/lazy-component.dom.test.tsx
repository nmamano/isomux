// lazyComponent keeps a heavy panel out of the first bundle (task ee3e0be8):
// its module loads when the panel first mounts, once for every mount, and a
// failed load leaves the rest of the office standing with a way to reload.
// React.lazy without an error boundary would unmount the whole app instead.

import { describe, expect, it } from "bun:test";
import { setUpDomTestFile } from "./test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render } = await import("@testing-library/react");
const { lazyComponent } = await import("./lazy-component.tsx");
const { onLanguage } = await import("./test-support/language-fixture.tsx");

type PanelProps = { label: string };
function Panel({ label }: PanelProps) {
  return <p data-testid="panel">{label}</p>;
}

function deferredLoad() {
  let calls = 0;
  let resolve: (c: typeof Panel) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<typeof Panel>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    load: () => {
      calls++;
      return promise;
    },
    calls: () => calls,
    resolve: (c: typeof Panel) => resolve(c),
    reject: (e: Error) => reject(e),
  };
}

// Lets the settled load reach React's state.
const flush = () =>
  act(async () => {
    await Bun.sleep(0);
  });

describe("lazyComponent", () => {
  it("loads on first mount, once for every mount, and passes props through", async () => {
    const d = deferredLoad();
    const LazyPanel = lazyComponent(d.load);
    // Defining it must not start the download: that would put the chunk back
    // on the first page load.
    expect(d.calls()).toBe(0);

    const view = render(
      <div>
        <LazyPanel label="one" />
        <LazyPanel label="two" />
      </div>,
    );
    expect(view.queryAllByTestId("panel").length).toBe(0);
    d.resolve(Panel);
    await flush();
    expect(view.getAllByTestId("panel").map((el) => el.textContent)).toEqual([
      "one",
      "two",
    ]);

    view.rerender(
      <div>
        <LazyPanel label="three" />
      </div>,
    );
    expect(view.getByTestId("panel").textContent).toBe("three");

    // A later mount, after the module is in, renders at once.
    const later = render(<LazyPanel label="four" />);
    expect(
      later.container.querySelector("[data-testid=panel]")?.textContent,
    ).toBe("four");
    expect(d.calls()).toBe(1);
  });

  it("a failed load keeps the rest of the page and offers a reload", async () => {
    const d = deferredLoad();
    let reloads = 0;
    const LazyPanel = lazyComponent(d.load, { reload: () => reloads++ });
    const view = render(
      <div>
        <span data-testid="sibling">office</span>
        <LazyPanel label="one" />
      </div>,
    );
    d.reject(new TypeError("Failed to fetch dynamically imported module"));
    await flush();

    expect(view.getByTestId("sibling").textContent).toBe("office");
    expect(view.queryAllByTestId("panel").length).toBe(0);
    const button = view.getByRole("button");
    expect(reloads).toBe(0);
    fireEvent.click(button);
    expect(reloads).toBe(1);
  });

  it("says it in the member's language", async () => {
    const failing = () => Promise.reject(new Error("offline"));
    const textOn = async (language: "en" | "es") => {
      const LazyPanel = lazyComponent<PanelProps>(failing, {
        reload: () => {},
      });
      const view = render(onLanguage(language, <LazyPanel label="x" />));
      await flush();
      const text = view.container.textContent ?? "";
      view.unmount();
      return text;
    };
    const en = await textOn("en");
    expect(en.trim().length).toBeGreaterThan(0);
    expect(await textOn("es")).not.toBe(en);
  });
});
