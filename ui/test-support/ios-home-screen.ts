// Makes happy-dom's navigator look like a given device, for the tests of what
// the iPhone Home Screen office does differently: links that leave for Safari
// (ui/safari-link.ts) and downloads (ui/home-screen-download.ts). Call it after
// setUpDomTestFile(); it returns the undo.

export const IPHONE_17 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

export interface DeviceNavigator {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  // Safari sets navigator.standalone only in a Home Screen web app.
  standalone?: boolean;
}

export const IPHONE_HOME_SCREEN: DeviceNavigator = {
  userAgent: IPHONE_17,
  platform: "iPhone",
  maxTouchPoints: 5,
  standalone: true,
};

export function asDevice(device: DeviceNavigator): () => void {
  const descriptors = Object.getOwnPropertyDescriptors(navigator);
  const keys = Object.keys(device);
  for (const [key, value] of Object.entries(device))
    Object.defineProperty(navigator, key, { configurable: true, value });
  return () => {
    for (const key of keys) {
      if (descriptors[key])
        Object.defineProperty(navigator, key, descriptors[key]);
      else Reflect.deleteProperty(navigator, key);
    }
  };
}

// The iOS share sheet and the file fetch behind a Home Screen download
// (ui/home-screen-download.ts). Every fetch answers with `body` under
// `contentType`; every share is recorded and resolves. Call it after
// setUpDomTestFile(); undo() restores navigator and fetch.
export interface ShareSheetStub {
  fetches: string[];
  shares: ShareData[];
  undo(): void;
}

export function stubShareSheet(
  body = "file bytes",
  contentType = "image/png",
): ShareSheetStub {
  const fetches: string[] = [];
  const shares: ShareData[] = [];
  const nav = {
    share: async (data: ShareData) => void shares.push(data),
    canShare: (data: ShareData) => (data.files?.length ?? 0) > 0,
  };
  const before = Object.getOwnPropertyDescriptors(navigator);
  for (const [key, value] of Object.entries(nav))
    Object.defineProperty(navigator, key, { configurable: true, value });
  const fakeFetch = async (input: string) => {
    fetches.push(input);
    return new Response(body, { headers: { "Content-Type": contentType } });
  };
  const globalFetch = globalThis.fetch;
  const windowFetch = window.fetch;
  globalThis.fetch = fakeFetch as typeof fetch;
  window.fetch = fakeFetch as typeof fetch;
  return {
    fetches,
    shares,
    undo() {
      for (const key of Object.keys(nav)) {
        if (before[key]) Object.defineProperty(navigator, key, before[key]);
        else Reflect.deleteProperty(navigator, key);
      }
      globalThis.fetch = globalFetch;
      window.fetch = windowFetch;
    },
  };
}
