// The top of phone content (task d60726c7). iOS 26 blurs the top edge of a
// page under the status bar unless an opaque fixed bar sits at the top of the
// screen (PhoneTopBar). Every phone surface that started at the status bar
// starts below that bar: at the status bar inset, or 12 px when the inset is
// 0 (a Home Screen app with a black status bar). WebKit ignores a fixed box
// of 10 px or less there.
export const PHONE_TOP = "max(env(safe-area-inset-top, 0px), 12px)";
