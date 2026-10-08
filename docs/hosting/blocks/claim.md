## Create the first owner

When Isomux starts with no owner, it prints a setup link in its terminal and
log, such as `http://localhost:4000/setup#key=...`. On the computer running
Isomux, open that link in a browser. Enter your display name and submit the
form. The office opens.

If the server has no browser, keep its Isomux terminal running. On your laptop,
open another terminal and run the following, replacing `USER` and `SERVER` with
your server login and address:

```sh
ssh -L 4000:localhost:4000 USER@SERVER
```

Keep this connection open and open the setup link in your laptop's browser.
Port 4000 on your laptop must be free.

The link carries the setup key, which is also in `~/.isomux/setup-key` on the
server. The office accepts its first owner only with this key. Set up remote
access after you have opened the office as its owner.
