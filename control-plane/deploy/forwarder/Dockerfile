# The certificate forwarder as a container image: one file on the same Bun as
# the provisioner, run as the image's unprivileged user. No dependencies, no
# state, no volume. The build context is the repository root.
FROM oven/bun:1.3.11-slim
WORKDIR /app
COPY control-plane/deploy/forwarder/forwarder.ts ./forwarder.ts
USER bun
ENV PORT=8080
CMD ["bun", "forwarder.ts"]
