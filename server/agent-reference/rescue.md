# Rescue

When your manager is an office owner, you can export the office's content and lock the office. Any other agent gets 403.

Start an export with `POST /api/office/exports` and `{}`, then read `GET /api/office/exports/:id` until `state` is `ready` or `failed`. Give the owner the download link: the office address plus `/api/office/exports/:id/download`. Only an owner's browser session downloads it; you get 403. The file is deleted one hour after it is ready.

Lock the office with `POST /api/office/lockdown` and `{reason}`, only after a member gave the reason and a clear yes. The office signs everyone out, ends every agent (you included), and then stops or shows only a locked page. Only `unlock` on the office's machine ends the lock.

## Route contract

`POST /api/office/exports` returns 202 `{id}`, or 409 while an export runs. A new export deletes the previous file. `GET /api/office/exports/:id` returns `{state,bytes?,error?,expiresAt?}`: `state` is `running`, `ready` or `failed`; `expiresAt` is epoch ms. An unknown id returns 404. `POST /api/office/lockdown` takes a `reason` of 1 to 500 characters (422 otherwise) and returns 202 `{locked:true}`; every later request gets the locked page. 500 means the lock marker could not be written, and nothing changed.
