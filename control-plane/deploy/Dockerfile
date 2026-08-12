# The provisioner as a container image.
#
# The build context is the REPOSITORY ROOT, and /.dockerignore is what keeps it
# small: control-plane/ is about 903 MB, of which control-plane/web is 901 MB,
# leaving 1.7 MB that this image is actually made of.
#
# WHERE THE DEPENDENCY LIVES, AND WHY IT IS NOT THE ROOT MANIFEST. The
# provisioner's only runtime dependency is `pg`; the repository's manifest also
# carries a UI, an agent SDK and a native terminal, none of which belong in a
# machine that holds provider credentials. So this image installs
# control-plane/deploy/package.json - one dependency, the same spec, held
# identical by control-plane/deploy/manifest.test.ts - at /app, which is an
# ANCESTOR of every control-plane import. Measured 2026-08-11: an import from
# below control-plane/ resolves to /app/node_modules/pg. Nothing is installed
# under control-plane/deploy/.
#
# The version is pinned to the same Bun the repository declares in
# `packageManager`, so the deployed runtime is the one the suite ran on.

FROM oven/bun:1.3.11-slim

# The driver shells `ssh` and keys.ts shells `ssh-keygen`. Neither is used while
# no box exists, and leaving them out would hide that gap until the slice that
# provisions one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY control-plane/deploy/package.json control-plane/deploy/bun.lock ./
RUN bun install --frozen-lockfile

COPY control-plane ./control-plane

# The state root is derived from the home directory (config.ts), so this is what
# puts the keys, run records, intent journal and audit log on the mounted
# volume. Private key material that a deploy destroyed would take the ability to
# revoke our own access with it.
ENV HOME=/data

# ENV above reaches only processes fly's init starts. `fly ssh console` builds
# its session from root's passwd entry instead (measured 2026-08-12: sessions
# resolved /root and wrote state to the ephemeral disk), so the passwd entry
# must agree with ENV or the machine has two state roots. sed rather than
# usermod: usermod refuses while root runs a process, and the build shell is
# one. The grep asserts the edit landed.
RUN sed -i 's|^\(root:.*:\)/root:\(.*\)$|\1/data:\2|' /etc/passwd \
    && grep -q '^root:.*:/data:' /etc/passwd

# --bind, because the default is loopback and fly's proxy is not on it. The
# address is `::` rather than `0.0.0.0`: fly reaches a machine over its private
# IPv6 network, and measured 2026-08-11, a Bun server bound to 0.0.0.0 answers
# IPv4 only while one bound to `::` answers both.
#
# --deployment carries fly's release id, which is what lets the state marker
# tell "the volume survived a deploy" from "a directory was recreated". The
# shell form is deliberate: the value is an environment variable of the machine,
# and there is nothing secret in it.
CMD ["sh", "-c", "exec bun control-plane/cli.ts run --bind :: --deployment \"${FLY_MACHINE_VERSION:-}\""]
