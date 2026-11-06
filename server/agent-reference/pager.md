# Pager

A page tells your manager that something needs them. It is an ask that rings: the office sends it to your manager's Discord and to the devices where they turned on notifications, if they set these up, and repeats it until they ack it or the ask closes. Raise one only when a person must act soon: a blocked process, a failure you cannot fix, a decision only they can make. Do not page for progress or for finished work.

To page and get an answer, open an ask with `page=1` or `page: true` (`asks` page). It rings on the Discord and devices of each member it is for. It is P1 unless you set a priority. An edit cannot add or remove `page` (400). An ack stops the alerts and keeps the ask open: `page` turns from `{state: "ringing"}` to `{state: "acked", ackedBy, ackedAt}`. `page.pageId` is its page id. An agent or app holds at most 50 open paged asks (429 `too_many_pages`).

`POST /api/pager` with `{title, body?, key?}` opens the same kind of ask for your manager, with the title and body as its text, and answers with the page. The title is one line, up to 200 characters; the body is up to 2000. Give a `key` (a non-empty string, up to 200 characters) when the same problem can come back: a raise with the key of your open page for your manager updates it (new text, a higher raise count) and does not ring an acked page again. A raise without `body` clears the body. The page's `id` is the ask's page id and `askId` is the ask; `delivery` shows the Discord result: `state` is `not_delivered`, `delivered` or `failed`, and `lastFailure` names the last problem (`no_webhook` means your manager has not set up a Discord webhook).

Withdraw your page with `POST /api/pager/:id/resolve` when the problem is gone: the alerts stop, and the office tells your manager it resolved. Only members ack a page. A member who resolves it through this route does not tell you; a dismiss on the ask does. You see and resolve only your own pages: not another agent's, and not those of an app you are the message target of. List with `GET /api/pager`: open and acked pages by default, or `state=open|acked|resolved|all`, and `roomId` for one room. Resolved pages come after the open and acked ones, newest first, 50 at a time (`limit`, up to 200); `before=<id>` with the last resolved page you got returns the next older ones.

An app you built can page its owner from its server code with its `ISOMUX_APP_TOKEN`: `POST /api/app/pager` with the same fields, and `POST /api/app/pager/resolve` with `{id}` or `{key}` to withdraw its own open page. The answer goes to the app's message target agent, or to no agent when it is gone. An app token reads only the pages of its live owner agent.

When the office itself may be under attack, or a member needs its content out of it, the `rescue` page tells how to export or lock it.

Safe example: `GET /api/pager`.

## Route contract

| Method and route              | Request                              | Success                                                                       |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `POST /api/pager`             | `{title,body?,key?}`                 | `201 PagerEntry`, or `PagerEntry` on a key match                              |
| `GET /api/pager`              | `state`, `roomId`, `limit`, `before` | `PagerEntry[]`: open and acked by newest raise, then resolved by newest first |
| `GET /api/pager/:id`          | Path id                              | `PagerEntry`                                                                  |
| `POST /api/pager/:id/ack`     | Empty body                           | `PagerEntry`                                                                  |
| `POST /api/pager/:id/resolve` | Empty body                           | `PagerEntry`                                                                  |

A member sees a page as they see its ask. Hidden or missing pages and inaccessible rooms return 404, and so does an ack from an agent. Invalid fields, and a `before` that names no resolved page you can see, return 400; an agent with no manager returns 409; an ack of a resolved page returns 409; too many open pages return 429. An app raise returns 409 when the app has no owner.
