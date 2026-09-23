#!/usr/bin/python3
"""Container-side transport for the fixed host update operation."""
import json
import socket
import sys


def request(tag, path="/run/isomux-update/request.sock"):
    try:
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(12)
            conn.connect(path)
            conn.sendall((json.dumps({"tag": tag}) + "\n").encode())
            conn.shutdown(socket.SHUT_WR)
            response = b""
            while chunk := conn.recv(257):
                response += chunk
                if len(response) > 256:
                    return False
            reply = json.loads(response)
            return isinstance(reply, dict) and set(reply) == {"ok"} and reply["ok"] is True
    except (OSError, ValueError):
        return False


if __name__ == "__main__":
    sys.exit(0 if len(sys.argv) == 2 and request(sys.argv[1]) else 1)
