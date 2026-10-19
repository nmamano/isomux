# Set up Hosted Isomux

Hosted Isomux is the paid option. You need an email address or a Google account
to sign in, a payment method, and an AI provider account. The service supplies the server and office
address. You do not need to buy a domain or install Isomux on your computer.

## Sign in and choose an office

1. Open [Hosted Isomux](https://cloud.isomux.com) and select **Sign in**.
2. Enter your email address, select **Email me a sign-in link**, and open the
   link in the email. Or select **Continue with Google**.
3. Select **Set one up**. Enter an office name and check the address preview.
   The address cannot be changed after setup.
4. Choose a plan. Check the current price and resources in the form before
   continuing. Hosting does not include AI provider usage.

## Save the administrator key and pay

The browser creates a server administrator SSH key. Download or copy the private
key and save it somewhere only you can access. This key can administer the
whole server. Keep it outside the office, where agents cannot read it.

Select **I saved it**, review the linked terms and policies, and select
**Continue to payment**. Complete payment on Stripe's checkout page and return
to the Hosted Isomux dashboard.

## Open the office

The dashboard shows setup progress. Wait until the office is serving, then
select **Get my owner invite**. Open the sign-in link in the browser profile you
will use for the office. The link works once and expires after five minutes;
request another if necessary.

Make sure the office opens in that browser. Return to the dashboard, confirm
that the office is open, and select **Remove Hosted Isomux Provisioning access**.
The dashboard reports the result. After access is removed, the provisioning
service cannot create another owner invite.

<!-- include: provider -->

<!-- include: invites -->

## Return to the office

Bookmark the office address. You can also sign in to the
[Hosted Isomux dashboard](https://cloud.isomux.com) and open the office from its
card. Use the office's device links when adding another browser or phone.

The dashboard holds billing and cancellation controls. Your administrator SSH
key is needed for server administration and repair; Isomux agents and the
built-in terminal do not have root access. Sign in as root from your own device
with `ssh -i <key file> root@<office address>`, where the office address is the
host name without `https://`.

## Update the office

When the office header reports a new release, the owner can open the Updates
pane and apply it. Finish active agent work first: the update restarts the
office. Keep the pane open through the restart, then refresh when it offers.
If the new version cannot start, the updater restores the previous code and state.

<!-- include: backup -->

For browser control and deployment boundaries, see the
[hosting reference](hosting-reference.md).
