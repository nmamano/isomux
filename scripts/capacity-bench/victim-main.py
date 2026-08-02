#!/usr/bin/env python3
"""Sacrificial stand-in for the office server where the SERVER IS THE MainPID.

The first fixture put the server's allocation in a python3 *child* of the
ExecStart bash, so the unit's MainPID was a tiny shell holding nothing. That is
not the shape of isomux.service, where the bun server is itself the MainPID and
holds its own few hundred MB - and the distinction decides whether
OOMPolicy=continue actually saves the office, because a unit whose MainPID dies
exits regardless of OOMPolicy.

Here this process is the MainPID and holds the largest allocation, then forks
its "agents" as children so they inherit its oom_score_adj the way the real
server's descendants do.

    usage: victim-main.py <parent-mb> <child-mb> [stamp]
"""
import os
import sys
import time

PARENT_MB = int(sys.argv[1])
CHILD_MB = int(sys.argv[2])
STAMP = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
PAGE = 4096


def hold(mb):
    buf = bytearray(mb * 1024 * 1024)
    for i in range(0, len(buf), PAGE):
        buf[i] = 1
    return buf


def stamp_self():
    # Raising oom_score_adj needs no privilege; only lowering does.
    if STAMP:
        try:
            with open("/proc/self/oom_score_adj", "w") as fh:
                fh.write(STAMP)
        except OSError:
            pass


def adj():
    with open("/proc/self/oom_score_adj") as fh:
        return fh.read().strip()


def spawn(role, mb, grow, delay):
    pid = os.fork()
    if pid:
        return pid
    # Children are forked BEFORE the server allocates. Forking afterwards makes
    # every child inherit the server's pages copy-on-write, so the kernel reads
    # the child's anon-rss as the server's 400 MB plus its own - and then picks a
    # child no matter what, which silently destroys the selection experiment.
    # Measured: a 245 MB runaway reported 645 MB anon-rss that way.
    stamp_self()
    print(f"{int(time.time())} {role} pid={os.getpid()} oom_score_adj={adj()}", flush=True)
    time.sleep(delay)
    if grow:
        chunks = []
        while True:
            chunks.append(hold(25))
            print(f"{role} {len(chunks) * 25} MB", flush=True)
            time.sleep(0.7)
    else:
        _buf = hold(mb)
        while True:
            time.sleep(1)


print(f"{int(time.time())} server-MAINPID pid={os.getpid()} oom_score_adj={adj()}", flush=True)
spawn("agent-a", CHILD_MB, False, 3)
# The runaway trips the fence while still smaller than the server, so that size
# alone would select the server and only the stamp can change that.
spawn("agent-runaway", 0, True, 8)

_server = hold(PARENT_MB)
print(f"{int(time.time())} server-MAINPID holds {PARENT_MB} MB", flush=True)

while True:
    time.sleep(1)
