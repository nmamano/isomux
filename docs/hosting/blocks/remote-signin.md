## Sign in at the new address

In the local office, open **Settings → Office → Access**. Enable **External
access**, paste the HTTPS office address into **Public URL**, and save.
Copy the sign-in link that the pane gives you before restarting.

On the server, run:

```sh
systemctl --user restart isomux
```

Open the copied sign-in link in the browser where you will use the office.
Keep the HTTPS office address as your bookmark; sign-in links work only once.
