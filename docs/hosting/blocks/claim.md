## Create the first owner

On the computer running Isomux, open `http://localhost:4000` in a browser.
Enter your display name and submit the form. The office opens.

If the server has no browser, keep its Isomux terminal running. On your laptop,
open another terminal and run the following, replacing `USER` and `SERVER` with
your server login and address:

```sh
ssh -L 4000:localhost:4000 USER@SERVER
```

Keep this connection open and visit `http://localhost:4000` in your laptop's
browser to create the owner. Port 4000 on your laptop must be free.

The office accepts its first owner only through this local connection. Set up
remote access after you have opened the office as its owner.
