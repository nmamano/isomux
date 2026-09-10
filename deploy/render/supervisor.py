"""Linux container supervisor. Private Unix RPC, no HTTP or provider secrets.

Each app invocation has its own subreaper. A normal shell exit still waits for
descendant cleanup. Unexpected worker death stops the container supervisor;
Docker then removes the namespace rather than letting an orphan retain a port.
RSS/process-count checks are sampled safeguards, NOT cgroup hard limits.
"""
import collections
import copy
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import subprocess
import sys
import time

MAX_FRAME = 1024 * 1024
MEMORY_BYTES = 512 * 1024 * 1024
MAX_PROCESSES = 256
LOG_BYTES = 2 * 1024 * 1024
RESTART_DELAY = 2
START_LIMIT = 5
START_WINDOW = 60
NAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


def write_json(path, value):
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf8") as out:
        os.chmod(tmp, 0o600)
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prctl(option, value):
    if ctypes.CDLL(None, use_errno=True).prctl(option, value, 0, 0, 0) != 0:
        raise RuntimeError("Required Linux process supervision is unavailable")


def descendants():
    """Return pid, start-time, RSS for this worker's tree, including adoptees."""
    rows = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text()
            fields = raw[raw.rindex(")") + 2:].split()
            rows[int(entry.name)] = (int(fields[1]), fields[19], int(fields[21]) * os.sysconf("SC_PAGE_SIZE"))
        except (FileNotFoundError, ProcessLookupError):
            continue
    parents = {os.getpid()}
    found = {}
    while True:
        batch = {pid: row for pid, row in rows.items() if row[0] in parents and pid not in found}
        if not batch:
            return found
        found.update(batch)
        parents.update(batch)


def send_pid(pid, start_time, sig):
    # Open a pidfd and check start time after opening: never signal a reused PID.
    try:
        fd = os.pidfd_open(pid)
        try:
            raw = Path(f"/proc/{pid}/stat").read_text()
            if raw[raw.rindex(")") + 2:].split()[19] == start_time:
                signal.pidfd_send_signal(fd, sig)
        finally:
            os.close(fd)
    except (ProcessLookupError, FileNotFoundError):
        pass


def worker(root, name):
    parent = os.getppid()
    prctl(36, 1)  # PR_SET_CHILD_SUBREAPER: double-forked children return here.
    stopping = False

    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    if os.getppid() != parent:
        return 1
    definition = json.loads((root / "definitions.json").read_text())[name]["definition"]
    env = dict(definition["env"])
    # Deliberately narrow inheritance. Render credentials and supervisor setup
    # secrets must never be copied into generated app environments.
    env.update(HOME=os.environ["HOME"], LANG="C.UTF-8")
    token_path = root / f"{name}.token.json"
    if token_path.exists():
        env["ISOMUX_APP_TOKEN"] = json.loads(token_path.read_text())
    try:
        child = subprocess.Popen(["/bin/sh", "-c", definition["command"]],
                                 cwd=definition["cwd"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 start_new_session=True)
    except OSError:
        write_json(root / f"{name}.exit.json", {"code": 1})
        return 0
    write_json(root / f"{name}.ready.json", {"ready": True})
    os.set_blocking(child.stdout.fileno(), False)
    log_path = root / f"{name}.log"
    log = open(log_path, "ab", buffering=0)
    os.chmod(log_path, 0o600)
    failed = False
    cleanup_at = None
    exit_code = None
    try:
        while True:
            chunk = child.stdout.read(65536)
            if chunk:
                if log.tell() + len(chunk) > LOG_BYTES:
                    log.close()
                    os.replace(log_path, root / f"{name}.log.1")
                    log = open(log_path, "ab", buffering=0)
                    os.chmod(log_path, 0o600)
                log.write(chunk)
            if exit_code is None:
                exit_code = child.poll()
            tree = descendants()
            if len(tree) > MAX_PROCESSES or sum(row[2] for row in tree.values()) > MEMORY_BYTES:
                failed = True
                stopping = True
            if stopping or exit_code is not None:
                if cleanup_at is None:
                    cleanup_at = time.monotonic()
                sig = signal.SIGKILL if time.monotonic() - cleanup_at > 2 else signal.SIGTERM
                for pid, (_, start_time, _) in tree.items():
                    send_pid(pid, start_time, signal.SIGCONT)
                    send_pid(pid, start_time, sig)
                # Reap adopted grandchildren as well as the shell. Do not reap
                # the shell before Popen captures its exit status.
                if exit_code is not None:
                    while True:
                        try:
                            pid, _ = os.waitpid(-1, os.WNOHANG)
                            if pid == 0:
                                break
                        except ChildProcessError:
                            break
                    if not descendants():
                        break
            select.select([child.stdout], [], [], 0.05)
        # A receipt distinguishes completed cleanup from unexpected worker loss.
        write_json(root / f"{name}.exit.json", {"code": 1 if failed else (exit_code or 0)})
        return 0
    finally:
        log.close()


class Supervisor:
    def __init__(self, root):
        self.root = root
        self.file = root / "definitions.json"
        self.records = json.loads(self.file.read_text()) if self.file.exists() else {}
        if not isinstance(self.records, dict):
            raise RuntimeError("Invalid supervisor state")
        self.live = {}
        self.runtime = {}
        self.attempts = {}
        self.next_start = {}
        self.committed = copy.deepcopy(self.records)
        for name, record in self.records.items():
            self.name(name)
            self.validate_definition(record["definition"])
            if record["definition"]["name"] != name:
                raise RuntimeError("Invalid app identity")
            if type(record["wanted"]) is not bool:
                raise RuntimeError("Invalid start intent")
            self.runtime[name] = {"state": "stopped", "restartCount": 0}
            if record["wanted"]:
                self.launch(name)

    def name(self, name):
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError("Invalid app name")
        return name

    def validate_definition(self, definition):
        self.name(definition["name"])
        if not isinstance(definition["command"], str) or not isinstance(definition["env"], dict):
            raise ValueError("Invalid app definition")
        if not Path(definition["cwd"]).is_absolute():
            raise ValueError("App working directory must be absolute")

    def save(self):
        try:
            write_json(self.file, self.records)
        except OSError:
            self.records = copy.deepcopy(self.committed)
            raise
        self.committed = copy.deepcopy(self.records)

    def launch(self, name):
        if name in self.live:
            return
        now = time.monotonic()
        starts = [t for t in self.attempts.get(name, []) if now - t < START_WINDOW]
        if len(starts) >= START_LIMIT:
            self.runtime[name]["state"] = "failed"
            self.next_start.pop(name, None)
            return
        starts.append(now)
        self.attempts[name] = starts
        (self.root / f"{name}.exit.json").unlink(missing_ok=True)
        ready = self.root / f"{name}.ready.json"
        ready.unlink(missing_ok=True)
        # Worker exceptions go to a private local diagnostic file, never Render logs.
        with open(self.root / f"{name}.worker.log", "wb") as log:
            proc = subprocess.Popen([sys.executable, __file__, "worker", str(self.root), name],
                                    stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        self.live[name] = proc
        self.runtime.setdefault(name, {"restartCount": 0})["state"] = "starting"
        self.next_start.pop(name, None)
        # Stop/restart cannot signal a worker before it installs its cleanup
        # handler. A receipt from a failed spawn also completes this handshake.
        deadline = time.monotonic() + 3
        while not ready.exists() and proc.poll() is None:
            if time.monotonic() > deadline:
                raise RuntimeError("App monitor did not become ready")
            time.sleep(0.01)
        if ready.exists():
            self.runtime[name]["state"] = "running"

    def tick(self):
        for name, proc in list(self.live.items()):
            if proc.poll() is None:
                continue
            receipt = self.root / f"{name}.exit.json"
            if proc.returncode != 0 or not receipt.exists():
                # An unproven cleanup is fatal to the container, never "stopped".
                raise RuntimeError("App monitor exited without proving cleanup")
            code = json.loads(receipt.read_text())["code"]
            del self.live[name]
            self.runtime[name]["state"] = "failed" if code else "stopped"
            if code and self.records[name]["wanted"]:
                self.runtime[name]["restartCount"] += 1
                self.runtime[name]["state"] = "starting"
                self.next_start[name] = time.monotonic() + RESTART_DELAY
        for name, at in list(self.next_start.items()):
            if time.monotonic() >= at:
                self.launch(name)

    def halt(self, name):
        self.next_start.pop(name, None)
        proc = self.live.get(name)
        if proc is not None:
            proc.terminate()
            deadline = time.monotonic() + 12
            while proc.poll() is None:
                if time.monotonic() > deadline:
                    raise RuntimeError("App cleanup did not finish; name and port remain reserved")
                time.sleep(0.02)
            # tick validates the cleanup receipt. Temporarily suppress auto restart.
            wanted = self.records[name]["wanted"]
            self.records[name]["wanted"] = False
            try:
                self.tick()
            finally:
                self.records[name]["wanted"] = wanted
        self.runtime.setdefault(name, {"restartCount": 0})["state"] = "stopped"

    def call(self, request):
        self.tick()
        op = request["op"]
        if op == "ping":
            return True
        if op == "states":
            return {self.name(n): self.runtime.get(n, {"state": "unknown", "restartCount": 0}) for n in request["names"]}
        if op in ("install", "regenerate", "reinstall"):
            definition = request["definition"]
            self.validate_definition(definition)
            name = definition["name"]
            old = self.records.get(name)
            was_active = name in self.live or name in self.next_start
            self.records[name] = {"definition": definition, "wanted": old["wanted"] if old else op != "regenerate"}
            self.save()
            self.runtime.setdefault(name, {"state": "stopped", "restartCount": 0})
            if op == "install" or (op == "reinstall" and (was_active or old is None)):
                self.halt(name)
                self.attempts[name] = []
                self.launch(name)
            return None
        name = self.name(request["name"])
        token_path = self.root / f"{name}.token.json"
        if op == "token.write":
            token = request["token"]
            if not isinstance(token, str) or len(token) > 16384:
                raise ValueError("Invalid app token")
            write_json(token_path, token)
            return None
        if op == "token.read":
            return json.loads(token_path.read_text()) if token_path.exists() else None
        if op == "token.remove":
            token_path.unlink(missing_ok=True)
            return None
        if op == "exists":
            return name in self.records
        if op == "descriptor.read":
            return self.records[name]["definition"]["descriptor"] if name in self.records else None
        if op == "delete" and name not in self.records:
            return None
        if name not in self.records:
            raise ValueError("App is not installed")
        if op == "descriptor.restore":
            descriptor = request["descriptor"]
            # Restore only the installed environment snapshot, preserving command,
            # credentials and start intent. Parse the exact shared writer format.
            env = self.records[name]["definition"]["env"]
            for key in ("ISOMUX_APP_URL", "ISOMUX_APP_HOST", "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"):
                env.pop(key, None)
            for line in descriptor.splitlines():
                if line.startswith('Environment="'):
                    assignment = json.loads(line[len("Environment="):])
                    key, value = assignment.split("=", 1)
                    if key in ("ISOMUX_APP_URL", "ISOMUX_APP_HOST"):
                        env[key] = value
            if "ISOMUX_APP_URL" in env:
                from urllib.parse import urlparse
                env["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS"] = urlparse(env["ISOMUX_APP_URL"]).hostname
            self.records[name]["definition"]["descriptor"] = descriptor
            self.save()
            return None
        if op in ("start", "stop", "restart", "delete"):
            self.records[name]["wanted"] = op in ("start", "restart")
            self.save()  # Stop intent survives a crash during cleanup.
            if op != "start":
                self.halt(name)
            if op in ("start", "restart"):
                self.attempts[name] = []
                self.launch(name)
            if op == "delete":
                del self.records[name]
                self.save()
                self.runtime.pop(name, None)
                self.attempts.pop(name, None)
                for suffix in ("token.json", "exit.json", "ready.json", "log", "log.1", "worker.log"):
                    (self.root / f"{name}.{suffix}").unlink(missing_ok=True)
            return None
        if op == "logs":
            count = max(0, min(1000, int(request["lines"])))
            if count == 0:
                return []
            lines = collections.deque(maxlen=count)
            for suffix in ("log.1", "log"):
                path = self.root / f"{name}.{suffix}"
                if path.exists():
                    with open(path, encoding="utf8", errors="replace") as src:
                        lines.extend(line.rstrip("\n")[-16384:] for line in src)
            # Keep the JSON RPC reply within the adapter's fixed response cap,
            # even when individual log lines contain many escaped characters.
            result = list(lines)
            while len(json.dumps(result).encode()) > MAX_FRAME and result:
                result.pop(0)
            return result
        raise ValueError("Unknown operation")


def receive(connection):
    data = bytearray()
    while True:
        chunk = connection.recv(min(65536, MAX_FRAME + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > MAX_FRAME:
            raise ValueError("Request too large")
    return json.loads(data)


def serve(root, office_command):
    os.umask(0o077)
    prctl(1, signal.SIGTERM)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(root / "lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    supervisor = Supervisor(root)
    endpoint = root / "control.sock"
    endpoint.unlink(missing_ok=True)
    server = socket.socket(socket.AF_UNIX)
    server.bind(str(endpoint))
    os.chmod(endpoint, 0o600)
    server.listen(16)
    stopping = False

    def stop(_sig, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    office = None
    office_log = open(root / "office.log", "ab") if office_command else None
    office_at = 0
    try:
        while not stopping:
            supervisor.tick()
            if office_command and (office is None or office.poll() is not None) and time.monotonic() >= office_at:
                if office is not None:
                    office.stdout.close()
                office = subprocess.Popen(office_command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                os.set_blocking(office.stdout.fileno(), False)
                office_at = time.monotonic() + 2
            if office is not None:
                chunk = office.stdout.read(65536)
                if chunk:
                    if office_log.tell() + len(chunk) > LOG_BYTES:
                        office_log.close()
                        os.replace(root / "office.log", root / "office.log.1")
                        office_log = open(root / "office.log", "ab")
                    office_log.write(chunk)
                    office_log.flush()
            if not select.select([server], [], [], 0.05)[0]:
                continue
            connection, _ = server.accept()
            with connection:
                connection.settimeout(2)
                try:
                    request = receive(connection)
                    response = {"ok": True, "value": supervisor.call(request)}
                except (ValueError, KeyError, TypeError, OSError):
                    response = {"ok": False, "error": "Invalid request or supervisor storage failure"}
                # RuntimeError is fatal: process cleanup was not proved.
                try:
                    connection.sendall(json.dumps(response).encode())
                except (BrokenPipeError, TimeoutError):
                    pass
    finally:
        server.close()
        endpoint.unlink(missing_ok=True)
        if office and office.poll() is None:
            office.terminate()
        for name in list(supervisor.live):
            supervisor.halt(name)
        if office:
            try:
                office.wait(timeout=5)
            except subprocess.TimeoutExpired:
                office.kill()
                office.wait()
            office.stdout.close()
        if office_log:
            office_log.close()


def main():
    os.umask(0o077)
    mode = sys.argv[1]
    if mode == "client":
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(18)
            connection.connect(sys.argv[2])
            data = sys.stdin.buffer.read(MAX_FRAME + 1)
            if len(data) > MAX_FRAME:
                return 1
            connection.sendall(data)
            connection.shutdown(socket.SHUT_WR)
            parts = []
            while chunk := connection.recv(65536):
                parts.append(chunk)
            sys.stdout.buffer.write(b"".join(parts))
        return 0
    if mode == "worker":
        return worker(Path(sys.argv[2]), sys.argv[3])
    if mode == "serve":
        serve(Path(sys.argv[2]), sys.argv[3:])
        return 0
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Detailed exceptions can contain app-authored data. Keep them out of
        # Render stdout/stderr; a failed control operation is visible via RPC.
        sys.stderr.write("Container supervision failed\n")
        sys.exit(1)
