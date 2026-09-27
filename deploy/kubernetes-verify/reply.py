"""Sends one message to the office's free OpenCode agent through the ingress,
as the owner, and waits for its reply. Run after `run.sh claim` with:
  run.sh client python3 /verify/reply.py
"""
import json
import secrets
import ssl
import time
import urllib.error
import urllib.request

OFFICE = "https://office.k8s.test"
# curl's cookie jar; its HttpOnly lines start with "#HttpOnly_".
cookie = "; ".join(
    "=".join(line.removeprefix("#HttpOnly_").split("\t")[5:7])
    for line in open("/work/cookies.txt").read().splitlines()
    if line and (not line.startswith("#") or line.startswith("#HttpOnly_")))
context = ssl.create_default_context(cafile="/work/ca.pem")


def api(path, body=None):
    request = urllib.request.Request(
        OFFICE + path, data=None if body is None else json.dumps(body).encode(),
        headers={"Origin": OFFICE, "Content-Type": "application/json", "Cookie": cookie})
    try:
        with urllib.request.urlopen(request, timeout=30, context=context) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{path}: HTTP {error.code}: {error.read()[:500]!r}") from None


# After the claim, the setup server hands over to the office, which then
# seeds its welcome agents.
deadline = time.monotonic() + 120
last = "no OpenCode agent yet"
while True:
    try:
        agents = api("/agents")
        agent = next((agent for agent in agents if (agent.get("model") or "").startswith("opencode/")), None)
        if agent:
            break
    except SystemExit as error:
        last = str(error)
    if time.monotonic() > deadline:
        raise SystemExit("office not ready 2 minutes after the claim: " + last)
    time.sleep(2)
print(f"agent {agent['name']} ({agent['model']})", flush=True)
word = "verify" + secrets.token_hex(4)
api(f"/api/agents/{agent['id']}/messages", {"text": f"Reply with the word {word} and nothing else."})
deadline = time.monotonic() + 240
while time.monotonic() < deadline:
    if api(f"/api/agents/{agent['id']}/logs?q={word}&kind=text")["totalMatches"]:
        print("reply received: " + word)
        break
    time.sleep(2)
else:
    raise SystemExit("no reply within 4 minutes")
