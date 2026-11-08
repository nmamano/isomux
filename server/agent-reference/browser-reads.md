# Browser reads

Part of the `browser` page: reads and actions in child frames, reads of one element, and what a snapshot shows.

Reads include child-frame labels and `framePath`; pass that path for frame actions. Paths index the current child frames, outer to inner, so read again after a page or frame change. Frame actions need one strict element `selector`; `press` in a frame requires a selector. Reads share a 20,000-character budget and include up to 64 frames through eight child levels.

For long feeds, `snapshot` and `text` accept an optional `selector` and/or `framePath`, for example `{"action":"snapshot","selector":"role=dialog"}` or `{"action":"text","framePath":[0],"selector":"article >> nth=20"}`. A scoped read returns one strict element in one frame, without child-frame sections. The default element is body and the default frame is the main frame. A snapshot marks a checked control `[checked]`; an unchecked one has no mark. A snapshot adds what ARIA omits, within its 20,000-character budget: the text of editable textboxes and all options of a grouped `<select>`. A snapshot shows a password field's value as `[password masked]`. Text that the page hides with `aria-hidden`, often after a dialog, gives a note in place of the snapshot; `role=` selectors do not match it either, so use `text` and CSS selectors.
