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

ARG TARGETARCH
ARG LEGO_VERSION=5.3.1

# The driver shells `ssh` and keys.ts shells `ssh-keygen`. Neither is used while
# no box exists, and leaving them out would hide that gap until the slice that
# provisions one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssh-client \
    && case "$TARGETARCH" in \
      amd64) LEGO_SHA=b3c71b122ee1947eacfe0b809b955647f6377239fe4bfc49f73b1a091ae1252a ;; \
      arm64) LEGO_SHA=58db563a2b97c2259516fa9910b4a9e1634a0737723d0381a65af1bf93a4b433 ;; \
      *) echo "unsupported lego architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSLo /tmp/lego.tar.gz "https://github.com/go-acme/lego/releases/download/v${LEGO_VERSION}/lego_v${LEGO_VERSION}_linux_${TARGETARCH}.tar.gz" \
    && echo "$LEGO_SHA  /tmp/lego.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/lego.tar.gz -C /usr/local/bin lego \
    && rm -f /tmp/lego.tar.gz \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY control-plane/deploy/package.json control-plane/deploy/bun.lock ./
RUN bun install --frozen-lockfile

COPY control-plane ./control-plane
COPY deploy/install.sh ./deploy/install.sh
RUN chmod 0755 /app/control-plane/cloudflare-dns-hook.ts

# Keep the image's payload inventory tied to every repository file that the
# running provisioner reads. This runs against the final deployed paths.
RUN bun control-plane/deploy/assert-runtime-files.ts

# The image contains no git metadata. Every build hashes its ACTUAL payload.
# The guarded activation path also passes the exact HEAD that describes its
# clean build context and its deploy-start time. A raw first deploy passes no
# source claim: absence is valid, while a malformed or half-present claim fails.
ARG ISOMUX_RELEASE_COMMIT
ARG ISOMUX_DEPLOY_STARTED_AT
RUN payload_sha256="$(find /app -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)" \
    && case "$payload_sha256" in (*[!0-9a-f]*|'') exit 1;; esac \
    && [ "${#payload_sha256}" -eq 64 ] \
    && if [ -z "$ISOMUX_RELEASE_COMMIT" ] && [ -z "$ISOMUX_DEPLOY_STARTED_AT" ]; then \
      printf '{"payload_sha256":"%s"}\n' "$payload_sha256"; \
    else \
      case "$ISOMUX_RELEASE_COMMIT" in (*[!0-9a-f]*|'') exit 1;; esac \
      && [ "${#ISOMUX_RELEASE_COMMIT}" -eq 40 ] \
      && echo "$ISOMUX_DEPLOY_STARTED_AT" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' \
      && \
      printf '{"payload_sha256":"%s","commit":"%s","deploy_started_at":"%s"}\n' \
        "$payload_sha256" "$ISOMUX_RELEASE_COMMIT" "$ISOMUX_DEPLOY_STARTED_AT"; \
    fi > /app/control-plane/deploy/release-identity.json

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
