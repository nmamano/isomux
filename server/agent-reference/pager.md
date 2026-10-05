# Pager

A page tells your manager that something needs them. For now, pages are only stored and listed in the office: no page is sent outside it yet, and every page shows `delivery.state` `not_delivered`. Raise one only when a person must act soon: a blocked process, a failure you cannot fix, a decision only they can make. Do not page for progress or for finished work.

Raise with `POST /api/pager` and `{title, body?, key?}`. The title is one line, up to 200 characters; the body is up to 2000. The token sets the source (you and your room) and the target (your manager). Give a `key` (a non-empty string, up to 200 characters) when the same problem can come back: a raise with the key of your open or acked page updates that page (new title and body, a higher raise count) instead of making a new one, and does not re-open an acked page. A raise without `body` clears the body of the page it updates. After a resolve, the same key makes a new page. A source can hold 50 open or acked pages.

Resolve your page with `POST /api/pager/:id/resolve` when the problem is gone. Members ack a page to say they saw it. List with `GET /api/pager`: open and acked pages by default, or `state=open|acked|resolved|all`, and `roomId` for one room.

Safe example: `GET /api/pager`.

## Route contract

| Method and route              | Request              | Success                                          |
| ----------------------------- | -------------------- | ------------------------------------------------ |
| `POST /api/pager`             | `{title,body?,key?}` | `201 PagerEntry`, or `PagerEntry` on a key match |
| `GET /api/pager`              | `state`, `roomId`    | `PagerEntry[]`, newest raise first               |
| `GET /api/pager/:id`          | Path id              | `PagerEntry`                                     |
| `POST /api/pager/:id/ack`     | Empty body           | `PagerEntry`                                     |
| `POST /api/pager/:id/resolve` | Empty body           | `PagerEntry`                                     |

A page is visible to callers with access to its source room; the source can always resolve its own page. Hidden or missing pages and inaccessible rooms return 404. Invalid fields return 400; an agent with no manager returns 409; an ack of a resolved page returns 409; too many open pages return 429.
