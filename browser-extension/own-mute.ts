// A mute this extension set on a tab, which nobody changed since. Chrome's
// tab menu cannot undo it (task ded3ae49).
export const ownMute = (info: ChromeMutedInfo | undefined): boolean =>
  info?.muted === true &&
  info.reason === "extension" &&
  info.extensionId === chrome.runtime.id;
