# One runner operation for a synchronous caller (server/member-app-host.ts):
# the office runs this file with spawnSync, which bounds it in time, and reads
# one JSON line from its stdout. It sends nothing before the listener's uid
# (SO_PEERCRED) is the uid the caller names, as RunnerStream does
# (server/agent-runner/client.ts). Python, not Bun: it starts in a fraction
# of the time, and the app states are read every few seconds.
#
#   stdin:  {"socket": path, "uid": n, "request": RunnerRequest,
#            "input"?: base64}
#   stdout: {"ok": true, "control": RunnerControl, "stdout": base64,
#            "stderr": base64}
#         | {"ok": false, "error": "peer" | "connect" | "protocol" | "closed"
#            | "too_big"}
#
# Frames (server/agent-runner/frames.ts): [u32 big-endian length][u8 type]
# [payload], the length counting the type byte; 1 JSON, 2 stdin, 3 stdout,
# 4 stderr.
import binascii
import json
import socket
import struct
import sys

FRAME_JSON, FRAME_STDIN, FRAME_STDOUT, FRAME_STDERR = 1, 2, 3, 4
MAX_FRAME_BYTES = 1024 * 1024
# The most output bytes one call takes (a journalctl of the log bound, a
# systemctl show of every app).
OUTPUT_MAX = 2 * 1024 * 1024
FINAL = {"exit", "fs", "error", "exiting", "info"}


def reply(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()
    sys.exit(0)


def encode(data):
    # binascii, not base64: base64 imports re, a tenth of the start time.
    return binascii.b2a_base64(data, newline=False).decode()


def frame(kind, payload):
    return struct.pack(">IB", len(payload) + 1, kind) + payload


def main():
    try:
        call = json.loads(sys.stdin.read())
        path = call["socket"]
        uid = call["uid"]
        request = call["request"]
        if not isinstance(path, str) or not isinstance(uid, int) or not isinstance(request, dict):
            raise ValueError
        data = binascii.a2b_base64(call["input"]) if "input" in call else None
    except Exception:
        reply({"ok": False, "error": "protocol"})
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        conn.connect(path)
    except OSError:
        reply({"ok": False, "error": "connect"})
    _pid, peer, _gid = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
    if peer != uid:
        reply({"ok": False, "error": "peer"})
    out = [frame(FRAME_JSON, json.dumps(request).encode())]
    if data is not None:
        for at in range(0, len(data), MAX_FRAME_BYTES - 1):
            out.append(frame(FRAME_STDIN, data[at:at + MAX_FRAME_BYTES - 1]))
        out.append(frame(FRAME_JSON, json.dumps({"type": "stdin-end"}).encode()))
    conn.sendall(b"".join(out))
    pending = b""
    stdout, stderr = [], []
    total = 0
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            reply({"ok": False, "error": "closed"})
        pending += chunk
        while len(pending) >= 4:
            (length,) = struct.unpack(">I", pending[:4])
            if length < 1 or length > MAX_FRAME_BYTES:
                reply({"ok": False, "error": "protocol"})
            if len(pending) < 4 + length:
                break
            kind, payload = pending[4], pending[5:4 + length]
            pending = pending[4 + length:]
            if kind in (FRAME_STDOUT, FRAME_STDERR):
                total += len(payload)
                if total > OUTPUT_MAX:
                    reply({"ok": False, "error": "too_big"})
                (stdout if kind == FRAME_STDOUT else stderr).append(payload)
            elif kind == FRAME_JSON:
                try:
                    message = json.loads(payload)
                except ValueError:
                    continue
                # Every output frame comes before the final report.
                if isinstance(message, dict) and message.get("type") in FINAL:
                    reply({
                        "ok": True,
                        "control": message,
                        "stdout": encode(b"".join(stdout)),
                        "stderr": encode(b"".join(stderr)),
                    })
            else:
                reply({"ok": False, "error": "protocol"})


main()
