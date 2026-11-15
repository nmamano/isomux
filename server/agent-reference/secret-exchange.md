# Secret token exchange

Part of the `connections` page.

## Using one

A secret with `exchange` holds an app or client secret: the proxy trades it for a short-lived token and sends the token. When its `form` is `{"kind":"query","param":"access_token"}`, put the placeholder as that parameter's whole value in the web address, for example `?access_token=$WECOM_APP`, not percent-encoded and not twice. A failed exchange gets 502 with the secret's name.

## Asking for one

`exchange` proposes a token exchange, for a service that trades an app id and secret for a token: `{url,body,id,params?,tokenField?,expiryField?}`, with `body` `{"kind":"oauth","clientAuth":"basic"}` (or `"body"`) or `{"kind":"json","idField":"app_id","secretField":"app_secret"}`; the host of `url` must be in `hosts`. With `exchange`, `form` can also be `{"kind":"query","param":"access_token"}`.
