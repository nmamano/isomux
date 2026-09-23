# Set up Isomux on AWS

This guide creates an Isomux office on an AWS virtual server (EC2). You will open
it at a web address such as `https://office.example.com`.

We recommend asking an agent to handle this setup. Point the agent to this guide.

You need an AWS account, a domain you control, and permission to edit that domain's
DNS records. AWS charges for the server, disks, and public IP address.

Commands marked **Server terminal** run on the AWS server after you connect to it.
Do not run them on your laptop or in AWS CloudShell.

## 1. Create the server

**AWS console → EC2 → Instances → Launch instances**

- Name the server `isomux`.
- Choose **Ubuntu Server 24.04 LTS**, with **64-bit (x86)** architecture.
- Choose a server with at least **2 CPUs and 8 GiB of memory** for this starting setup.
- Create a key pair and download the key file. You will use it to connect to the server.
- In **Network settings**, allow:
  - **SSH (port 22)** from **My IP**. If another person or agent will administer
    the server, add their public IP as a separate SSH rule.
  - **HTTP (port 80)** from **Anywhere-IPv4**.
  - **HTTPS (port 443)** from **Anywhere-IPv4**.
- In **Storage**, use two encrypted **gp3** disks:
  - **30 GiB root disk** for Ubuntu, Docker, and the Isomux image.
  - **Additional disk** for your office data and projects; **30 GiB is a
    recommended starting size**, not a minimum. Turn off
    **Delete on termination** for this disk so deleting the server does not
    delete your office data. Increase its size if your projects need more space.
- Launch the server and wait for its status checks to pass.

## 2. Give the office a web address

**AWS console → EC2 → Elastic IP addresses**

- Allocate an Elastic IP address and associate it with the new server. This gives
  the server a public IP address that stays the same when you stop and start it.
- Choose an office address under your domain. This guide uses
  `office.example.com`; replace it with your own address throughout.

**Your domain provider → DNS settings**

- Add an **A** record for `office`, pointing to the server's Elastic IP address.
- Add an **A** record for `*.office`, pointing to the same IP address. Isomux uses
  these addresses for apps created in the office, such as `notes.office.example.com`.
- If your office address uses a different prefix, use that prefix in both records.
  Some DNS providers ask for the full name instead, such as `office.example.com`.

[About Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html).

## 3. Connect to the server

**AWS console → EC2 → Instances → select your server → Connect → SSH client**

- Follow the SSH instructions shown there, using the key file you downloaded.
- Use the server's Elastic IP address and the Ubuntu username `ubuntu`.
- Once connected, run the remaining terminal commands in that server session.

**Server terminal**

```sh
sudo apt-get update
sudo apt-get install -y curl jq
```

The Isomux installer will install Docker, Compose, and Caddy.

## 4. Prepare the data disk

This step makes the additional disk available at `/srv/isomux-data` on the server.
Isomux will store your office data there.

**Server terminal**

- List the disks:

  ```sh
  lsblk -o NAME,SERIAL,SIZE,FSTYPE,MOUNTPOINTS
  ```

- Find the additional disk by comparing its serial number with its **Volume ID**
  in **AWS console → EC2 → Volumes**. The serial omits the dash in `vol-…`.
- Do not select the disk containing `/` in the mount-point column; that is the
  Ubuntu disk. The new data disk should have no filesystem or mount point.
- Set `DATA_DEVICE` to the data disk's path. Replace the placeholder below with
  the name you found, including `/dev/`:

  ```sh
  DATA_DEVICE=/dev/REPLACE_WITH_DATA_DISK
  sudo wipefs --no-act "$DATA_DEVICE"
  ```

- The last command should produce no output for a blank disk. If it lists an
  existing filesystem, stop: formatting that disk would erase its data.
- Format only the new, blank data disk and create the folder where it will appear:

  ```sh
  sudo mkfs.ext4 "$DATA_DEVICE"
  sudo mkdir -p /srv/isomux-data
  sudo blkid -s UUID -o value "$DATA_DEVICE"
  ```

- Copy the UUID printed by the last command. Open the file that tells Ubuntu
  which disks to mount when it starts:

  ```sh
  sudo cp /etc/fstab /etc/fstab.before-isomux
  sudo nano /etc/fstab
  ```

- Add this line at the bottom, replacing `REPLACE_WITH_UUID` with the copied UUID:

  ```fstab
  UUID=REPLACE_WITH_UUID /srv/isomux-data ext4 defaults,nofail,x-systemd.device-timeout=30s 0 2
  ```

- In nano, press **Ctrl+O**, **Enter**, then **Ctrl+X** to save and exit.
- Mount the disk and check the result:

  ```sh
  sudo systemctl daemon-reload
  sudo mount /srv/isomux-data
  findmnt /srv/isomux-data
  ```

- The output should show your data disk mounted at `/srv/isomux-data`.

[AWS disk preparation instructions](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-using-volumes.html).

## 5. Install Isomux

On the [Isomux container images page](https://github.com/nmamano/isomux/pkgs/container/isomux),
choose the release's full version tag, which starts with `v`.

**Server terminal**

- Set the release version, replacing `REPLACE_WITH_RELEASE_TAG` with that tag:

  ```sh
  ISOMUX_RELEASE=REPLACE_WITH_RELEASE_TAG
  ```

- Download the installer for the same release:

  ```sh
  curl --fail --show-error --location \
    "https://raw.githubusercontent.com/nmamano/isomux/$ISOMUX_RELEASE/deploy/install.sh" \
    --output install-isomux.sh
  ```

- If the download reports an error, stop and check the release tag.
- Run the installer. Replace `office.example.com` with your office address:

  ```sh
  sudo env ISOMUX_INSTALL_MODE=container \
    ISOMUX_REF="$ISOMUX_RELEASE" DOMAIN=office.example.com \
    bash install-isomux.sh
  ```

The installer downloads the image, saves a random setup key, and configures
Docker, Caddy, the firewall, and automatic Ubuntu security updates. It keeps SSH
port 22 open and leaves SSH authentication unchanged. It uses the data disk
prepared in step 4; it does not format disks.

If installation fails, fix the reported problem and run the same command again.
The installer keeps the saved setup key and image version. A rerun restarts the
office and its apps. It refuses to replace an existing direct-host office or a
custom Caddy configuration.

## 6. Check that Isomux started

**Server terminal**

```sh
sudo systemctl is-active isomux-container.service
```

- The command should print `active`.
- The service starts Isomux automatically after a server reboot, once the data
  disk is mounted. It refuses to start if the disk is missing, read-only, or has
  a different UUID.

## 7. Open the office

Caddy provides HTTPS automatically. Open your office address in your browser,
for example `https://office.example.com`. You should see **Set up your office**.

If it does not load, check that both DNS records point to the Elastic IP and
that the server allows inbound ports 80 and 443. DNS changes can take time to appear.

## 8. Create your owner account

**Server terminal**

- Display the setup key generated in step 5:

  ```sh
  sudo sed -n 's/^ISOMUX_SETUP_KEY=//p' /opt/isomux-container/office.env
  ```

**Your browser → your office address**

- Paste that key into **Setup key**.
- Enter your name. You can change it later.
- Select **Create office**. The office should open and the receptionist should greet you.

**Optional: remove the unused setup key**

- The setup key cannot claim the office again after an owner exists. Removing it
  is extra protection against leaving an unused secret in the server's configuration.
- To remove it, run the following in the **server terminal**. This briefly restarts
  the office and its apps:

  ```sh
  sudo sed -i '/^ISOMUX_SETUP_KEY=/d' /opt/isomux-container/office.env
  sudo systemctl restart isomux-container.service
  ```

## 9. Connect an AI provider

**Your browser → Settings → You → Individual connections**

- For Claude or Codex, select its sign-in control and complete the instructions.
  If Isomux asks to install the Claude CLI, complete that step first. Codex is
  bundled. For OpenCode, open or create an OpenCode agent and choose a Free
  model in its model picker, or configure a paid provider connection.
- If you use a provider API key, add its environment variable in Individual
  connections: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENCODE_API_KEY`.
  Provider charges and subscription limits are separate from AWS hosting.
- For Claude through Amazon Bedrock, use the
  [Bedrock setup instructions](https://isomux.com/docs/access-and-invites#claude-on-amazon-bedrock).
- Open an agent that uses that provider and send a short message. A reply confirms
  that the office can use your provider account.
- To invite someone else, open **Settings → Office → Invites**.

Your office is ready. Keep using the same office URL to return to it.

## Office logs

If the office does not start, run these commands in the **server terminal**:

```sh
sudo journalctl -u isomux-container.service -n 50 --no-pager
sudo tail -n 50 /srv/isomux-data/home/.isomux/container-runtime/office.log
```

## Update the office

When the office header reports a new release, the owner can open the Updates
pane and apply it. Finish active agent work first: the update restarts the
office. Keep the pane open through the restart, then refresh when it offers.

Container updates do not take a snapshot or roll back automatically. Keep
independent backups of the complete EBS volume.

## Add devices and keep backups

In **Settings → You → Sign-in links**, create a device link and open it on your
other device. For another person, use **Settings → Office → Invites**. Only
invite people you trust: members and their agents can run commands within the
office's operating-system account.

Isomux keeps seven daily backups of its state on the same data disk. These do
not cover the complete home and workspace directories. Keep separate snapshots
of the complete EBS volume for recovery from disk loss.

For source builds, custom deployments, and technical details, see the
[container reference](reference.md).
