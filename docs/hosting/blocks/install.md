## Install Isomux

Run these steps on the computer that will run the office, in a terminal under
its normal user account.

1. Install [Node.js 24 LTS](https://nodejs.org/en/download), version 24.15.0 or
   later, using the instructions for your operating system. Node.js is needed
   to install Claude Code with npm. Open a new terminal after installation.
2. Install Git. On Ubuntu or Debian:

   ```sh
   sudo apt update
   sudo apt install -y git curl unzip
   ```

   On macOS, run `xcode-select --install` and complete the installer.

3. Install [Bun](https://bun.sh):

   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

   Open a new terminal so that the shell can find Bun. Check both runtimes:

   ```sh
   node --version
   bun --version
   ```

   Node must report `v24.15.0` or later in the Node 24 series; Bun must be at least
   version 1.3.11.

4. Download Isomux into a new directory and start it:

   ```sh
   git clone https://github.com/nmamano/isomux.git
   cd isomux
   bun install
   bun run dev
   ```

   Leave this terminal open.

A Chrome-family browser installed on this computer also enables page-preview
cards. It is optional for office setup.
