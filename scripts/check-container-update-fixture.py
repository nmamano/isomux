#!/usr/bin/env python3
"""Unprivileged client for the root updater fixture. Never print credentials."""
from http.client import HTTPConnection, HTTPException
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.parse

FIXTURE = Path("/var/lib/isomux-update-fixture")
ORIGIN = "https://fixture.example.invalid"
PORT = 10000


def http(path, method="GET", data=None, cookie=None, form=False):
    headers = {"Origin": ORIGIN}
    if cookie:
        headers["Cookie"] = cookie
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data) if form else json.dumps(data)
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
    conn = HTTPConnection("127.0.0.1", PORT, timeout=5)
    try:
        conn.request(method, path, body, headers)
        response = conn.getresponse()
        content = response.read()
        return response.status, {name.lower(): value for name, value in response.getheaders()}, content
    finally:
        conn.close()


def wait_ready(cookie, commit, release):
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            code, _, _ = http("/readyz")
            status, _, raw = http("/api/version", cookie=cookie)
            identity = json.loads(raw) if status == 200 else {}
            if code == 200 and identity.get("commit") == commit and identity.get("release") == release:
                return
        except (OSError, ValueError, HTTPException):
            pass
        time.sleep(1)
    raise AssertionError("Client did not observe the expected running release and readiness")


def shell(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL).strip()


def unit_started():
    return shell("systemctl", "show", "isomux-update@v2099.1.2.service", "--property=ExecMainStartTimestampMonotonic", "--value")


def main():
    assert os.geteuid() != 0, "Run the client as an unprivileged account"
    manifest = json.loads((FIXTURE / "manifest.json").read_text())
    code, headers, _ = http("/setup", "POST", {"name": "Fixture Owner", "key": (FIXTURE / "setup-key").read_text().strip()}, form=True)
    assert code == 200, "Fixture setup failed"
    owner = headers["set-cookie"].split(";", 1)[0]
    wait_ready(owner, manifest["fromCommit"], manifest["fromTag"])
    code, _, raw = http("/api/office/update", cookie=owner)
    assert code == 200 and json.loads(raw)["managed"] is True
    old_container = shell("docker", "ps", "-q", "--filter", "label=com.docker.compose.project=isomux", "--filter", "label=com.docker.compose.service=office")
    assert old_container
    # Create a real member through the office's invite flow.
    code, _, raw = http("/api/invites", "POST", {"username": "Fixture Member", "role": "member"}, owner)
    assert code == 200 or code == 201, "Fixture member invite failed"
    invite = json.loads(raw)["url"]
    code, headers, _ = http("/auth/accept", "POST", {"token": urllib.parse.urlparse(invite).path.removeprefix("/i/")}, form=True)
    assert code in (200, 302, 303), "Fixture member acceptance failed"
    member = headers["set-cookie"].split(";", 1)[0]
    before = unit_started()
    assert http("/api/office/update", "POST", {"tag": manifest["toTag"]}, member)[0] == 403
    assert http("/api/office/update", "POST", {"tag": manifest["toTag"]})[0] == 401
    assert unit_started() == before, "Non-owner request started the root updater"
    for body in [{"tag": "../other.service"}, {"tag": manifest["toTag"], "command": "anything"}]:
        assert http("/api/office/update", "POST", body, owner)[0] == 400
    bad = [b'{}\n', b'[]\n', b'{"tag":"v2099.1.2","tag":"v2099.1.2"}\n',
           b' ' * 257 + b'\n', b'{"tag":"v2099.1.2"}\n{}\n']
    bad.append(b' ' * 237 + b'{"tag":"v2099.1.2"}\n')  # 257 bytes, valid JSON
    for tag in ["main", "v2099.1.2\n", "../other.service", "v2099.1.2 other.service", "$(id)", "v2099.1.2;id"]:
        bad.append((json.dumps({"tag": tag}) + "\n").encode())
    for field in ["command", "path", "unit", "docker", "operation"]:
        bad.append((json.dumps({"tag": manifest["toTag"], field: "ignored"}) + "\n").encode())
    for payload in bad:
        with socket.socket(socket.AF_UNIX) as sock:
            sock.settimeout(20)
            sock.connect("/run/isomux-update/request.sock")
            sock.sendall(payload)
            sock.shutdown(socket.SHUT_WR)
            raw = b""
            while chunk := sock.recv(256):
                raw += chunk
            assert json.loads(raw) == {"ok": False}, "Malformed socket request accepted"
    assert unit_started() == before, "Malformed request started the root updater"
    start = time.monotonic()
    code, _, raw = http("/api/office/update", "POST", {"tag": manifest["toTag"]}, owner)
    assert code == 202 and json.loads(raw) == {"ok": True, "via": "system", "tag": manifest["toTag"]}
    assert time.monotonic() - start < 15, "Update request did not detach"
    wait_ready(owner, manifest["toCommit"], manifest["toTag"])
    new_container = shell("docker", "ps", "-q", "--filter", "label=com.docker.compose.project=isomux", "--filter", "label=com.docker.compose.service=office")
    assert new_container and "\n" not in new_container and new_container != old_container, "Office container was not replaced"
    deadline = time.monotonic() + 30
    while shell("systemctl", "show", "isomux-update@v2099.1.2.service", "--property=ActiveState", "--value") == "activating":
        assert time.monotonic() < deadline, "Updater did not finish"
        time.sleep(1)
    assert shell("systemctl", "show", "isomux-update@v2099.1.2.service", "--property=Result", "--value") == "success"
    print("PASS: root socket refusal, owner authorization, detached update, container replacement, client readiness and built identity; lane " + manifest["laneCommit"])
    print("Run the reviewed root teardown command even after a failed client check.")


if __name__ == "__main__":
    main()
