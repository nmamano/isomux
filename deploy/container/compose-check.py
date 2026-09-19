#!/usr/bin/env python3
"""Exercise the Compose command on isolated storage, never the reference EBS path."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

root = Path(__file__).resolve().parent
environment = {**os.environ, "ISOMUX_IMAGE": sys.argv[1],
               "ISOMUX_PUBLIC_URL": "https://office.example.com",
               "ISOMUX_SETUP_KEY": "synthetic-compose-setup-key-for-local-check",
               "ISOMUX_MEMORY_LIMIT": "2g", "ISOMUX_CPUS": "1"}
project = "isomux-compose-check-" + uuid.uuid4().hex[:8]
with tempfile.TemporaryDirectory(prefix=project) as temporary:
    override = Path(temporary) / "override.yaml"
    command = ["docker", "compose", "--env-file", "/dev/null", "-p", project,
               "-f", str(root / "compose.yaml"), "-f", str(override)]

    def run(*args, check=True):
        return subprocess.run(command + list(args), env=environment, text=True,
                              capture_output=True, timeout=45, check=check)

    override.write_text("""services:
  office:
    network_mode: none
    ports: !reset []
    volumes: !override
      - fixture:/var/data
volumes:
  fixture: {}
""")
    foreground = None
    try:
        # Parse the shipped file too, without printing its environment.
        parsed = subprocess.run(command[:-2] + ["config", "--format", "json"],
                                env=environment, capture_output=True, text=True, check=True)
        service = json.loads(parsed.stdout)["services"]["office"]
        assert service["restart"] == "no"
        assert service["volumes"][0]["bind"].get("create_host_path", False) is False
        for replacement in (False, True):
            foreground = subprocess.Popen(command + ["up", "--no-build", "--pull", "never",
                                          "--abort-on-container-exit", "--exit-code-from", "office"],
                                          env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 45
            while True:
                result = run("exec", "-T", "office", "bun", "deploy/container/probe.ts", check=False)
                if result.returncode == 0:
                    break
                assert foreground.poll() is None and time.monotonic() < deadline
                time.sleep(.3)
            container = run("ps", "-q", "office").stdout.strip()
            inspected = subprocess.run(["docker", "inspect", "--format", "{{json .HostConfig}}", container],
                                       capture_output=True, text=True, check=True)
            config = json.loads(inspected.stdout)
            assert config["Memory"] == 2 * 1024**3 and config["NanoCpus"] == 10**9
            assert config["Privileged"] is False and config["NetworkMode"] == "none"
            if replacement:
                result = run("exec", "-T", "office", "cat", "/var/data/workspaces/compose-check")
                assert result.stdout == "persisted"
            else:
                run("exec", "-T", "office", "bun", "-e", "await Bun.write('/var/data/workspaces/compose-check','persisted')")
            run("stop", "--timeout", "30")
            _, error = foreground.communicate(timeout=40)
            assert foreground.returncode in (0, 143), error
            print(f"Compose explicit stop exit={foreground.returncode}", flush=True)
            foreground = None
        print("PASS Compose foreground startup, stop, replay, limits, and retained data", flush=True)
        run("down", "--volumes")
        missing = Path(temporary) / "absent-data"
        override.write_text(f"""services:
  office:
    network_mode: none
    ports: !reset []
    volumes: !override
      - type: bind
        source: {missing}
        target: /var/data
        bind:
          create_host_path: false
""")
        failed = run("up", "-d", "--no-build", "--pull", "never", check=False)
        assert failed.returncode != 0 and not missing.exists()
        print("PASS Compose refuses a missing data source", flush=True)
    finally:
        run("down", "--volumes", "--timeout", "30", check=False)
        if foreground is not None:
            foreground.communicate(timeout=40)
