#!/usr/bin/env python3
"""Isolated local image acceptance. No host credentials, network, or model turns."""
import json
import subprocess
import sys
import time
import uuid

image = sys.argv[1]
name = "isomux-check-" + uuid.uuid4().hex[:10]
volume = name + "-data"
origin = "https://office.example.com"
key = "synthetic-container-setup-key-for-local-test"


def run(*args, input=None, timeout=60):
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{args[:3]} failed ({result.returncode}): {result.stderr[-2000:]}")
    return result.stdout.strip()


def execute(*args, input=None):
    return run("docker", "exec", "-i", "--user", "node", "-e", "HOME=/var/data/home",
               "-e", "ISOMUX_HOME=/var/data/home/.isomux", name, *args, input=input)


def start(first=False, nonroot=False):
    args = ["docker", "run", "-d", "--name", name, "--network", "none",
            "--memory", "2g", "--cpus", "2", "-v", volume + ":/var/data",
            "-e", "ISOMUX_PUBLIC_URL=" + origin]
    if first:
        args += ["-e", "ISOMUX_SETUP_KEY=" + key]
    if nonroot:
        args += ["--user", "1000:1000"]
    run(*args, image)


def request(path="/", method="GET", body=None, cookie=None, host="office.example.com", form=False):
    headers = {"Host": host, "Origin": origin, "Accept": "application/json"}
    if cookie:
        headers["Cookie"] = cookie
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        if not form:
            body = json.dumps(body)
    return json.loads(execute("python3", "-c", """
import http.client,json,sys
p=json.load(sys.stdin)
c=http.client.HTTPConnection('127.0.0.1',10000,timeout=5)
c.request(p['method'],p['path'],p['body'],p['headers'])
r=c.getresponse()
print(json.dumps({'status':r.status,'headers':{k.lower():v for k,v in r.getheaders()},'body':r.read().decode()}))
""", input=json.dumps(dict(path=path, method=method, body=body, headers=headers))))


def ready(status):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if request()["status"] == status:
                return
        except RuntimeError:
            pass
        time.sleep(.3)
    raise RuntimeError("office did not reach expected HTTP status " + str(status))


def check(response, status):
    assert response["status"] == status, (response["status"], status)
    return response


def app_cookie(cookie):
    minted = check(request("/auth/app?app=counter&r=%2F", cookie=cookie), 302)
    from urllib.parse import urlsplit
    target = urlsplit(minted["headers"]["location"])
    redeemed = check(request(target.path + "?" + target.query, host="counter.office.example.com"), 302)
    return redeemed["headers"]["set-cookie"].split(";", 1)[0]


try:
    run("docker", "volume", "create", volume)
    start(first=True)
    ready(200)
    execute("bun", "deploy/container/probe.ts")
    check(request("/setup", "POST", "name=Fixture&key=wrong", form=True), 403)
    claimed = check(request("/setup", "POST", "name=Fixture&key=" + key, form=True), 200)
    cookie = claimed["headers"]["set-cookie"].split(";", 1)[0]
    ready(401)
    execute("bun", "deploy/container/probe.ts")
    check(request(cookie=cookie), 200)
    assert request("/setup", "POST", "name=Replacement&key=" + key, form=True)["status"] != 200
    print("PASS setup key, single claim, authenticated office, pre/post-claim probe", flush=True)
    run("docker", "run", "-d", "--name", name + "-second", "--network", "none",
        "--memory", "256m", "--user", "node", "-v", volume + ":/var/data",
        "-e", "ISOMUX_PUBLIC_URL=" + origin, image)
    assert run("docker", "wait", name + "-second", timeout=10) == "1"
    run("docker", "rm", name + "-second")
    print("PASS second data writer refused by supervisor lock", flush=True)
    print(execute("bun", "deploy/container/native-check.ts"), flush=True)
    screenshot = "/tmp/" + name + "-browser.png"
    run("docker", "cp", name + ":/tmp/isomux-native-check.png", screenshot)
    print("Browser screenshot: " + screenshot, flush=True)

    execute("bun", "-e", """
import {writeFileSync} from 'node:fs';
writeFileSync('/var/data/workspaces/preserved.txt','persistent-project');
writeFileSync('/var/data/home/provider-state-fixture','synthetic-state-no-login');
writeFileSync('/var/data/workspaces/counter.ts', `
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
const file=process.env.ISOMUX_APP_DATA_DIR+'/counter';
let count=existsSync(file)?Number(readFileSync(file,'utf8')):0;
Bun.serve({hostname:process.env.ISOMUX_APP_HOST,port:Number(process.env.PORT),
fetch(req,server){if(server.upgrade(req))return;writeFileSync(file,String(++count));return Response.json({count,pid:process.pid,uid:process.getuid()});},
websocket:{message(ws,msg){ws.send(msg)}}});`);
""")
    for app in ("counter", "stopped"):
        check(request("/api/apps", "POST", {"name": app, "command": "bun counter.ts", "cwd": "/var/data/workspaces"}, cookie), 201)
    check(request("/api/apps/stopped/stop", "POST", {}, cookie), 200)
    check(request(host="unknown.office.example.com"), 404)
    check(request(host="counter.office.example.com"), 302)
    app_session = app_cookie(cookie)
    deadline = time.monotonic() + 10
    while True:
        response = request(host="counter.office.example.com", cookie=app_session)
        if response["status"] == 200:
            break
        assert time.monotonic() < deadline
        time.sleep(.2)
    before = json.loads(response["body"])
    assert before["uid"] == 1000
    print("PASS app API, child-host access, unknown-host refusal, non-root app", flush=True)
    execute("python3", "-c", """
import json,socket,sys
cookie=json.load(sys.stdin)
s=socket.create_connection(('127.0.0.1',10000),timeout=5)
s.sendall(('GET /echo HTTP/1.1\\r\\nHost: counter.office.example.com\\r\\n'
 'Upgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\n'
 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://counter.office.example.com\\r\\n'
 'Cookie: '+cookie+'\\r\\n\\r\\n').encode())
head=b''
while b'\\r\\n\\r\\n' not in head:head+=s.recv(4096)
assert head.startswith(b'HTTP/1.1 101 ')
payload=b'hello';mask=b'abcd'
s.sendall(bytes([129,128+len(payload)])+mask+bytes(c^mask[i%4] for i,c in enumerate(payload)))
data=b''
while len(data)<7:data+=s.recv(4096)
assert data[:2]==bytes([129,5]) and data[2:7]==payload
s.close()
""", input=json.dumps(app_session))
    print("PASS app WebSocket echo through office Host dispatch", flush=True)
    # Kill only the office child; leave the supervisor and running app intact.
    execute("python3", "-c", """
import os,signal
for pid in os.listdir('/proc'):
 if pid.isdigit():
  try:
   args=open('/proc/'+pid+'/cmdline','rb').read().split(b'\\0')
   if args[:2]==[b'bun',b'deploy/container/office.ts']:os.kill(int(pid),signal.SIGTERM)
  except (FileNotFoundError,ProcessLookupError):pass
""")
    time.sleep(3)
    ready(401)
    after = json.loads(check(request(host="counter.office.example.com", cookie=app_cookie(cookie)), 200)["body"])
    assert after["pid"] == before["pid"] and after["count"] > before["count"]
    print("PASS office restart preserves running app PID", flush=True)

    started = time.monotonic()
    run("docker", "stop", "--time", "30", name)
    elapsed = time.monotonic() - started
    assert run("docker", "inspect", "--format", "{{.State.ExitCode}}", name) != "137"
    print(f"PASS container stop completed without SIGKILL in {elapsed:.1f}s", flush=True)
    run("docker", "rm", name)
    start(nonroot=True)
    ready(401)
    execute("bun", "deploy/container/probe.ts")
    check(request(cookie=cookie), 200)
    assert execute("cat", "/var/data/workspaces/preserved.txt") == "persistent-project"
    assert execute("cat", "/var/data/home/provider-state-fixture") == "synthetic-state-no-login"
    after = json.loads(check(request(host="counter.office.example.com", cookie=app_cookie(cookie)), 200)["body"])
    assert after["count"] > before["count"]
    apps = json.loads(check(request("/api/apps", cookie=cookie), 200)["body"])
    if isinstance(apps, dict):
        apps = apps["apps"]
    assert next(app for app in apps if app["name"] == "stopped")["state"] == "stopped"
    print("PASS non-root replacement without setup key preserves owner, home, project, counter and stopped intent", flush=True)
    for app in ("counter", "stopped"):
        check(request("/api/apps/" + app, "DELETE", cookie=cookie), 204)
    print("PASS app deletion", flush=True)
finally:
    subprocess.run(["docker", "rm", "-f", name + "-second"], capture_output=True)
    subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    subprocess.run(["docker", "volume", "rm", volume], capture_output=True)
