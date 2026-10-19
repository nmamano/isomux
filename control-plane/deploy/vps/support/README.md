# Hosted support lookup

A read-only lookup of one customer account on the Hosted Isomux database, for
the support runbook (`internal-docs/support-runbook.md`). Support runs one SSH
command from the operator's machine and gets one JSON line. No connection
string, password or database port leaves the host.

```
ssh <ssh options> -i <support key> hostedsupport@<host> <email address>
```

The exact command, with the host and the key path, is in the operator's private
notes (`internal-docs/private/hosted-vps-loop.md` in the main checkout). The
output has every account whose email equals the address case-insensitively (an
empty `accounts` list when there is none), each with its offices and the
records the runbook checks. Keys are the column names. The lookup does not read
operation evidence, free-text details, sign-in subjects, SSH keys, provider
addresses or host keys, checkout session ids, certificate credentials or
reinstatement attempts.

An address outside the accepted pattern (a local part of at most 64 ASCII
letters, digits and `._%+-`, a domain that ends in a letters-only top-level
domain, 254 characters in all) exits with `FAIL email`, before the database is
reached. An apostrophe is refused even where an email provider allows one. If a
customer's address is refused, escalate; do not work around the lookup.

## How it is built

- `hosted-support-ssh` is the forced command of the `hostedsupport` login. It
  refuses a login with no command (exit 2) and sends the command, the address,
  to the read program on stdin.
- `hosted-support-read` runs as root through one sudoers rule with no
  arguments. It reads one line, checks the pattern, finds the one running `db`
  container of the `isomux-hosted` Compose project, and sends `lookup.sql` to
  psql in that container, as the role `hostedsupport_read`, over the local
  socket. The address goes to psql only as the variable `email`, which psql
  quotes as a literal. The query runs as a prepared statement in a read-only
  transaction. It prints the one output line, or one `FAIL <stage>` line on
  stderr with exit 1, and writes one syslog line (tag `hosted-support`) with
  the result and counts, never the address. psql's stderr is dropped.
- `role.sql` creates `hostedsupport_read` (login with no password, no
  inheritance, read-only default, a statement timeout) and grants SELECT on the
  columns `lookup.sql` reads and on nothing else.
- `13-hosted-support.conf` is the sshd drop-in, and `94-hostedsupport` is the
  sudoers rule.

## Install

As root on the host, from a checkout of this directory:

1. The program and its query in one directory, because the program reads
   `lookup.sql` from its own directory:
   `install -d -m 0755 /usr/local/lib/hosted-support`, then
   `install -m 0755 hosted-support-read hosted-support-ssh /usr/local/lib/hosted-support/`,
   `install -m 0644 lookup.sql /usr/local/lib/hosted-support/`, and
   `ln -s /usr/local/lib/hosted-support/hosted-support-read /usr/local/sbin/`,
   `ln -s /usr/local/lib/hosted-support/hosted-support-ssh /usr/local/sbin/`.
2. The role: `docker exec -i -u postgres <db container> psql -X -v ON_ERROR_STOP=1 -d isomux < role.sql`.
3. The login: a user `hostedsupport` with no password and a root-owned
   `~/.ssh/authorized_keys` that holds one line,
   `from="<operator machine address>",restrict,no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,command="/usr/local/sbin/hosted-support-ssh" <public key>`.
   The private key stays on the operator's machine, mode 0600.
4. `visudo -cf 94-hostedsupport`, then install it as
   `/etc/sudoers.d/94-hostedsupport`, mode 0440.
5. sshd: `13-hosted-support.conf` in `/etc/ssh/sshd_config.d/`, and
   `hostedsupport` added to `AllowUsers` if the host sets it. Arm a timer that
   restores the old configuration before the reload, run `sshd -t`, reload,
   prove that a new administrator login still works, then cancel the timer.

Run `role.sql` again after every `restore.sh`: restore keeps only the
bootstrap's grants. When Hosted Isomux moves to a new host, install the lookup
there after `restore.sh` (see "Moving Hosted Isomux to a Docker host" in
`control-plane/README.md`).

Proofs to take at the install: one real lookup returns the JSON; an address
with a quote is refused with `FAIL email` and no database call; a login with no
command and a request for a TTY are refused; a write as `hostedsupport_read`
in a `begin read write` transaction is refused with permission denied; and the
other forced-command logins on the host are unchanged.
