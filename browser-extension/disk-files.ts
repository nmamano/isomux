import {
  extensionOutdated,
  validExtensionPackage,
} from "../shared/browser-extension-protocol";

// The version of manifest.json on disk, when it is newer than the version
// Chrome runs. Chrome reads an unpacked extension's files from disk at each
// fetch, but its manifest only at a load. A failed read counts as none.
export async function newerFiles(): Promise<string | undefined> {
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), {
      cache: "no-store",
    });
    const { version } = (await response.json()) as { version?: unknown };
    return validExtensionPackage(version) &&
      extensionOutdated(chrome.runtime.getManifest().version, version)
      ? version
      : undefined;
  } catch {
    return undefined;
  }
}
