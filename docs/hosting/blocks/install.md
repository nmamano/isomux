## Install Isomux

Run these steps on the computer that will run the office, in a terminal under
its normal user account.

1. Install Git. On Ubuntu or Debian:

   ```sh
   sudo apt update
   sudo apt install -y git curl unzip
   ```

   On macOS, run `xcode-select --install` and complete the installer.

2. Install [Bun](https://bun.sh):

   ```sh
   curl -fsSL https://bun.sh/install | bash
   ```

   Open a new terminal so that the shell can find Bun. Check its version:

   ```sh
   bun --version
   ```

   Bun must be at least version 1.3.11.

3. Download Isomux into a new directory and start it:

   ```sh
   git clone https://github.com/nmamano/isomux.git
   cd isomux
   bun install
   bun run dev
   ```

   Leave this terminal open.

A Chrome-family browser installed on this computer also enables page-preview
cards. It is optional for office setup.
