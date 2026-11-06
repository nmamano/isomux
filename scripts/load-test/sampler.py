# Samples every process in a cgroup each second: RSS, PSS-free anon (from
# status), and CPU ticks, grouped by kind (server = the bun office process,
# engine = claude, other). Writes JSON lines to <out>.
# usage: python3 -I sampler.py <cgroup dir> <out> [<server pid>]
import json, os, sys, time

cg, out = sys.argv[1], sys.argv[2]
server_pid = int(sys.argv[3]) if len(sys.argv) > 3 else None
hz = os.sysconf("SC_CLK_TCK")
prev = {}
prev_t = time.time()
with open(out, "a") as f:
    while True:
        t = time.time()
        try:
            pids = [int(p) for p in open(os.path.join(cg, "cgroup.procs")).read().split()]
        except OSError:
            break
        rows = {}
        for pid in pids:
            try:
                st = open(f"/proc/{pid}/stat").read()
                comm = st[st.index("(") + 1 : st.rindex(")")]
                fields = st[st.rindex(")") + 2 :].split()
                ticks = int(fields[11]) + int(fields[12])
                rss = anon = 0
                for line in open(f"/proc/{pid}/status"):
                    if line.startswith("VmRSS:"):
                        rss = int(line.split()[1])
                    elif line.startswith("RssAnon:"):
                        anon = int(line.split()[1])
            except (OSError, ValueError, IndexError):
                continue
            kind = "server" if pid == server_pid else ("engine" if comm.startswith("claude") else "other")
            cpu = (ticks - prev.get(pid, ticks)) / hz / max(t - prev_t, 1e-3)
            prev[pid] = ticks
            rows[pid] = (kind, comm, rss, anon, cpu)
        agg = {}
        for kind, comm, rss, anon, cpu in rows.values():
            a = agg.setdefault(kind, {"n": 0, "rssKB": 0, "anonKB": 0, "cpu": 0.0})
            a["n"] += 1
            a["rssKB"] += rss
            a["anonKB"] += anon
            a["cpu"] += cpu
        mem = {}
        for name in ("memory.current", "memory.peak"):
            try:
                mem[name] = int(open(os.path.join(cg, name)).read())
            except OSError:
                pass
        try:
            psi = open("/proc/pressure/cpu").read().split()[1]
        except OSError:
            psi = None
        avail = None
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable:"):
                avail = int(line.split()[1])
        f.write(json.dumps({"t": t, "agg": agg, "cg": mem, "load1": os.getloadavg()[0], "psiCpu": psi, "memAvailKB": avail}) + "\n")
        f.flush()
        prev_t = t
        time.sleep(max(0, 1 - (time.time() - t)))
