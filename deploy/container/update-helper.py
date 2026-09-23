#!/usr/bin/python3
"""One socket connection can enqueue one fixed release update operation."""
import json
import re
import subprocess
import sys

TAG = re.compile(r"v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?", re.ASCII)
ENV = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def request(raw, run=subprocess.run):
    try:
        if len(raw) > 256 or not raw.endswith(b"\n"):
            raise ValueError("invalid framing")
        body = json.loads(raw, object_pairs_hook=unique_object)
        if not isinstance(body, dict) or set(body) != {"tag"}:
            raise ValueError("invalid fields")
        tag = body["tag"]
        if not isinstance(tag, str) or TAG.fullmatch(tag) is None:
            raise ValueError("invalid tag")
        result = run(["/usr/bin/systemctl", "start", "--no-block",
                      "isomux-update@" + tag + ".service"],
                     env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, timeout=10, check=False)
        return result.returncode == 0
    except (ValueError, UnicodeError, OSError, subprocess.SubprocessError):
        return False


if __name__ == "__main__":
    accepted = request(sys.stdin.buffer.read(257))
    if not accepted:
        print("Container update request refused", file=sys.stderr)
    print(json.dumps({"ok": accepted}), flush=True)
