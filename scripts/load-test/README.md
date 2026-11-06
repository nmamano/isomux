# Load test

The tools behind the capacity numbers of the enterprise agreement. Run them
again when a deal names another box size or a release changes the memory per
agent. Method, results and the sizing rule for other boxes:
`internal-docs/private/load-test-2026-11.md` (the 2026-11 run). Nothing here
runs in CI.

Two tiers:

- **Tier B, the full stack.** The office installed from a pushed ref with
  `deploy/install.sh`, as a customer does, with the real claude CLI per agent.
  `mock.ts` stands in for the Anthropic Messages API, so no tokens are spent.
  It measures the ref given to `office-setup.sh`.
- **Tier A, the server alone.** `tier-a-server.ts` boots the server of the
  checkout it sits in with the test harness and a fake engine. On AWS that
  checkout is `/opt/lt-src`, a copy of the office's installed tree, so both
  tiers measure the same ref. The ref must contain `scripts/load-test/`.

`gen.ts` opens the member sockets, sends the turns and API calls and times
them. `analyze.ts` reduces each level to one row. The level files hold the
2026-11 levels.

## On AWS

Needs the AWS CLI signed in to the account. An account on the AWS Free plan
cannot start an m7i.2xlarge.

1. `./aws-up.sh <usd cap> [<office type>]` launches the office VM (default
   m7i.2xlarge) and a c7i.large generator, tagged `Name=isomux-load-test`.
   It refuses while tagged VMs still run. It prints the rate in USD/h and the
   minutes the cap buys; both VMs power off and terminate by themselves after
   them. The 2026-11 run took 2.5 hours (cap 10). Files go to
   `/tmp/isomux-load-test`. Do not reboot the VMs: a reboot clears the
   power-off. After a reboot, run `aws-down.sh`.
2. Office: `./acme-window.sh open`, then copy `mock.ts`, `sampler.py` and
   `office-setup.sh` to the office VM and run
   `sudo ./office-setup.sh <public IP>.sslip.io <ref>`, where `<ref>` is a
   release tag or a branch (the same in step 3). Then
   `./acme-window.sh close`. Port 443 then answers only the generator and
   this machine.
3. Generator: copy `gen-setup.sh` and run
   `sudo ./gen-setup.sh <domain> <office private IP> <bun version> <ref>`.
   Copy the owner invite from the office VM to the generator. Only root
   can read it. It signs in as the owner, so do not put it in a chat or a
   log. From this directory:

   ```sh
   . ./lib.sh; . $WORK/aws.env
   ssh $SSH_OPTS ubuntu@$OFF_PUB sudo cat /var/lib/isomux-install/invite-url |
     ssh $SSH_OPTS ubuntu@$GEN_PUB 'umask 077; cat > lt/B/claim-url'
   ```

4. Tier B, on the generator: `bun run ~/isomux/scripts/load-test/setup-b.ts
~/lt/B 100 https://<domain>`, delete `claim-url`, then
   `~/isomux/scripts/load-test/levels-b.sh <levels-b.txt>` in a
   `systemd-run` unit (it runs for hours). For the memory levels, run
   `setup-b.ts ~/lt/B 60 https://<domain>` again (it adds the agents in a
   new room), then `levels-b.sh <levels-b-memory.txt>`.
5. `./fetch.sh B` prints one row per level.
6. Tier A, as root on the office VM: `systemctl stop isomux lt-sampler`,
   `cp -a /opt/isomux /opt/lt-src`, `bun install` in it, then
   `levels-a.sh <levels-a.txt>` from `/opt/lt-src/scripts/load-test/`, in a
   `systemd-run` unit. `./fetch.sh A`.
7. `./aws-down.sh` removes every tagged resource, then checks that none is
   left. It exits 1 on a leftover. Run it also when the cap ended the run.

## Local smoke run

Checks the tools against a checkout before you spend money. From the checkout
root, with a run directory `$R`:

```sh
LT_DIR=$R LT_AGENTS=5 LT_MEMBERS=3 bun test ./scripts/load-test/tier-a-server.ts &
# when $R/server.json exists:
LT_DIR=$R LT_CLIENTS=10 LT_BUSY=3 LT_WARMUP_S=5 LT_DURATION_S=20 bun run scripts/load-test/gen.ts
touch $R/stop
bun run scripts/load-test/analyze.ts $R
```

The row must show 0 errors, and `toEngine.n` within one of `ack.n` (every send
reached the engine; the last one can arrive after the generator stops).
