// Makes happy-dom's navigator look like a given device, for the tests of the
// links that leave the iPhone Home Screen office for Safari
// (ui/safari-link.ts). Call it after setUpDomTestFile(); it returns the undo.

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
