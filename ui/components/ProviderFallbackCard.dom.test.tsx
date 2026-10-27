import { afterAll, expect, it } from "bun:test";
import { setUpDomTestFile } from "../test-support/dom.ts";

setUpDomTestFile();

const { act, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { ProviderFallbackCard } = await import("./ProviderFallbackCard.tsx");
const { onLanguage } = await import("../test-support/language-fixture.tsx");
const { setApiShim, ApiError } = await import("../api.ts");
const { createElement } = await import("react");

// The owner's switch for the fallback to the office sign-in (task 2008c993),
// on the office half of Integrations > Model providers. A change saves at
// once through the version-guarded settings PUT, with only its own field.

afterAll(() => {
  setApiShim(null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mount = () =>
  render(onLanguage(null, createElement(ProviderFallbackCard)));

it("shows the stored switch, neither on nor off while it loads", async () => {
  const settings = deferred<unknown>();
  setApiShim(async () => settings.promise);
  const view = mount();
  const box = view.getByRole("checkbox") as HTMLInputElement;
  expect(box.disabled).toBe(true);
  expect(box.indeterminate).toBe(true);
  await act(async () =>
    settings.resolve({ version: "1", providerFallback: true }),
  );
  expect(box.disabled).toBe(false);
  expect(box.indeterminate).toBe(false);
  expect(box.checked).toBe(true);
  view.unmount();
});

it("saves a change at once with only its own field and the version, and shows the stored value after", async () => {
  let stored = false;
  let version = 1;
  const writes: Record<string, unknown>[] = [];
  setApiShim(async (method, path, body) => {
    if (path !== "/api/office/settings") throw new Error(`no shim for ${path}`);
    if (method === "PUT") {
      writes.push(body as Record<string, unknown>);
      stored = (body as { providerFallback: boolean }).providerFallback;
      version++;
      return undefined;
    }
    return {
      name: "Office name",
      version: String(version),
      memberUsageCap: true,
      memberUsageShare: 80,
      providerFallback: stored,
    };
  });
  const view = mount();
  await act(async () => {});
  const box = () => view.getByRole("checkbox") as HTMLInputElement;
  expect(box().checked).toBe(false);

  await act(async () => fireEvent.click(box()));
  expect(writes).toEqual([{ version: "1", providerFallback: true }]);
  expect(box().checked).toBe(true);

  // The next change carries the version of the read after the save.
  await act(async () => fireEvent.click(box()));
  expect(writes.at(-1)).toEqual({ version: "2", providerFallback: false });
  expect(box().checked).toBe(false);
  expect(view.queryByRole("alert")).toBeNull();
  view.unmount();
});

it("says a refused save and keeps showing the stored value", async () => {
  setApiShim(async (method) => {
    if (method === "PUT")
      throw new ApiError(409, "version_conflict", "Settings changed");
    return { version: "1", providerFallback: false };
  });
  const view = mount();
  await act(async () => {});
  const box = view.getByRole("checkbox") as HTMLInputElement;
  await act(async () => fireEvent.click(box));
  expect(view.getByRole("alert").textContent?.trim()).not.toBe("");
  expect(box.checked).toBe(false);
  view.unmount();
});

it("shows nothing for a server without the setting", async () => {
  let known = true;
  setApiShim(async () =>
    known
      ? { version: "1", providerFallback: false }
      : { version: "1", memberUsageCap: false },
  );
  let view = mount();
  await act(async () => {});
  expect(view.queryByRole("checkbox")).not.toBeNull();
  view.unmount();

  known = false;
  view = mount();
  await act(async () => {});
  expect(view.queryByRole("checkbox")).toBeNull();
  view.unmount();
});

// The card and the member usage card sit on the same tab and write the same
// version-guarded settings blob, whose version covers both fields. A save in
// one must not make the other's next save a conflict.
it("saves after a save in the member usage card beside it, and the other way round", async () => {
  const { IntegrationsFake } =
    await import("../test-support/integrations-fake.ts");
  const { OWNER, card, open, tab } =
    await import("../test-support/integrations-page-fixture.ts");
  const fake = new IntegrationsFake({ username: "Ricky", owner: true }, [
    "Ricky",
    "Stephen",
  ]);
  const stored: Record<string, unknown> = {
    memberUsageCap: false,
    memberUsageShare: 80,
    providerFallback: false,
  };
  const version = () => JSON.stringify(stored);
  const writes: Record<string, unknown>[] = [];
  setApiShim(async (method, path, body) => {
    // The usage card reads each provider's line once its cap is on.
    if (path.startsWith("/api/office/member-usage-status"))
      return { memberUsageStatus: [] };
    if (path !== "/api/office/settings") return fake.handle(method, path, body);
    if (method === "GET") return { version: version(), ...stored };
    const b = body as Record<string, unknown>;
    if (b.version !== version())
      throw new ApiError(409, "version_conflict", "Settings changed");
    writes.push(b);
    for (const key of Object.keys(stored))
      if (b[key] !== undefined) stored[key] = b[key];
    return undefined;
  });
  const view = await open(OWNER);
  await tab(view, "providers");
  const office = card(view, "office");
  const fallbackBox = () =>
    office.querySelector<HTMLInputElement>(
      "[data-provider-fallback-card] input[type=checkbox]",
    )!;
  const usage = () =>
    office.querySelector<HTMLElement>("[data-member-usage-card]")!;
  const alerts = () => office.querySelectorAll('[role="alert"]').length;

  await act(async () => fireEvent.click(fallbackBox()));
  await waitFor(() => expect(fallbackBox().disabled).toBe(false));
  expect(stored.providerFallback).toBe(true);

  await act(async () =>
    fireEvent.click(usage().querySelector("input[type=checkbox]")!),
  );
  const { t } = (await import("../../shared/i18n/translate.ts")).translatorFor(
    "en",
  );
  const save = [...usage().querySelectorAll("button")].find(
    (button) => button.textContent === t("common.save"),
  )!;
  await act(async () => fireEvent.click(save));
  await waitFor(() => expect(save.disabled).toBe(false));
  expect(stored.memberUsageCap).toBe(true);

  await act(async () => fireEvent.click(fallbackBox()));
  await waitFor(() => expect(fallbackBox().disabled).toBe(false));
  expect(stored.providerFallback).toBe(false);
  expect(alerts()).toBe(0);
  // Each write moved the version, so a stale one is refused.
  expect(writes).toHaveLength(3);
  expect(new Set(writes.map((w) => w.version)).size).toBe(3);
  view.unmount();
});
