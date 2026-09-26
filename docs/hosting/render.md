# Set up Isomux on Render

[Render](https://render.com) runs the office as one Docker web service on a paid compute plan with a persistent disk. The `render.yaml` at the root of the isomux repository declares that service, and Render reads it when you create a Blueprint.

You need a Render account, a payment method for the compute plan and disk, an AI provider account, and a domain you control. Apps that agents build get their own subdomains under the office address, and Render's `onrender.com` addresses cannot provide those. Pick the office address before you start, for example `office.example.com`. Use a workspace with no other isomux service in it: a Blueprint that names a service already in the workspace takes that service over instead of creating a new one.

1. Create the service. In the Render dashboard, open [New > Blueprint](https://dashboard.render.com/blueprints), paste `https://github.com/nmamano/isomux` into the **Public Git Repository** field, and keep the `main` branch on the next screen. Name the Blueprint after the office, for example `isomux-office`. Render lists one web service with a 20 GB disk and asks for one value, `ISOMUX_PUBLIC_URL`: enter `https://` followed by your office address. Apply, and wait until the new web service shows Live. [Render's Blueprint docs](https://render.com/docs/infrastructure-as-code).
2. Point your domain at it. From the Dashboard, open the web service the Blueprint created (named `isomux`), then Settings > Custom Domains, and add both `office.example.com` and `*.office.example.com` (the wildcard serves the apps from the [personal software suite](https://nilmamano.com/blog/personal-software-suites) on subdomains to avoid using ports). Render shows the DNS records to create at your registrar; copy them exactly (note that the wildcard domain will require 3 CNAME entries; Render will walk you through adding them). Wait until `office.example.com` shows Certificate Issued; the wildcard's certificate takes longer and is only needed once you open an app. [Render's custom domain docs](https://render.com/docs/custom-domains).
3. Claim the office. Open the service's Environment tab and copy the value of `ISOMUX_SETUP_KEY`, which Render generated for you. Open your office address in a browser and enter the key and your name. You are the first owner; the key stops working after that, and you add other people through Settings → Invites in the office.

Only the disk, mounted at `/var/data`, survives a deploy; the rest of the container is rebuilt from the image. Agents' home directory is on the disk, so their default working directory is safe. A project created anywhere else is gone after the next deploy.

<!-- include: provider -->

<!-- include: invites -->

## Apps and logs

To check that app subdomains work, ask an agent to build a small app and open it.
Render provides HTTPS for the office and configured app domains.

Use Render's service logs for build and container startup failures. Office and
app logs are on the persistent disk under
`/var/data/home/.isomux/container-runtime`. Keep projects under `/var/data` so
that replacement does not remove them.

## Update the office

The office header shows when a new release is out. Automatic deployments are
disabled in the Blueprint. To update, use the web service's manual deployment
control after you have finished active agent work.
A deployment replaces the container and interrupts the office and its apps.
Check the office and app URLs after the new deployment is live.

<!-- include: backup -->

Keep an independent copy or snapshot of the complete persistent disk for
recovery from disk loss. The office backup alone does not include all projects
and provider files. See the [container reference](https://github.com/nmamano/isomux/blob/main/deploy/container/reference.md)
for advanced runtime details.
