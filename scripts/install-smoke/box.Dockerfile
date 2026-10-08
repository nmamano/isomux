# A fresh Ubuntu 24.04 server for the installer path: systemd as PID 1, an SSH
# server, and the tools a cloud image ships. deploy/install.sh does the rest.
# Not pinned on purpose: the check follows the Ubuntu a new server gets.
FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd systemd-sysv dbus openssh-server sudo curl ca-certificates git iproute2 \
  && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
# systemd needs a writable cgroup tree. With a private cgroup namespace the
# remount reaches only this container's own subtree.
ENTRYPOINT ["/bin/sh", "-c", "mount -o remount,rw /sys/fs/cgroup && exec /sbin/init"]
