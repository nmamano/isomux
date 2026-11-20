#!/usr/bin/env python3
"""The member OS users of the container (internal-docs/member-os-user-design.md,
sections 1.3 and 2). Root runs it: the entrypoint at each start (boot), and
the command isomux-member-user from `docker exec -u 0` (the other verbs).

Homes, shares and the record of the users live on the data volume, under
/var/data/members, because the image keeps neither /etc, /home nor /var/lib.
The office user owns /var/data, so every change under /var/data/members goes
through a file descriptor of a folder that only root can change, never
through a path that the office user could replace with a link.

  member-users.py boot
  member-users.py next-id
  member-users.py add <osuser> <uid> <gid> <member id>
  member-users.py start <osuser>
  member-users.py stop <osuser>
  member-users.py lock <osuser>
  member-users.py check-made <osuser> <member id>
  member-users.py delete <osuser> <member id>

The tests change the constants below through importlib; nothing here reads
the environment.
"""
import fcntl
import grp
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import sys
import time

ROOT = "/var/data/members"
LOGIN_DEFS = "/etc/login.defs"
RUN_ROOT = "/run"
EXPECT_UID = 0
OFFICE_USER = "node"
LOOP = "/opt/isomux/deploy/container/member-runner-loop.sh"
SETPRIV = "/usr/bin/setpriv"
BASH = "/bin/bash"
# The pattern of the command (deploy/isomux-member-user.sh, NAME_RE).
NAME = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
USERS = "users.json"
SUBFOLDERS = ("home", "share", "etc")
LOOP_ENV_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class Refused(Exception):
    pass


def log(message):
    print(f"[member-users] {message}", file=sys.stderr, flush=True)


def check_root_dir(fd, label):
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        raise Refused(f"{label} is not a folder")
    if info.st_uid != EXPECT_UID:
        raise Refused(f"{label} is owned by uid {info.st_uid}, not root")
    if info.st_mode & 0o022:
        raise Refused(f"{label} has group or other write")


def open_dir(name, dir_fd, label, create):
    """A root-only folder, opened without following a link; made root 0755
    when `create` and it is missing."""
    made = False
    if create:
        try:
            os.mkdir(name, 0o755, dir_fd=dir_fd)
            made = True
        except FileExistsError:
            pass
    try:
        fd = os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    except OSError as error:
        raise Refused(f"{label} cannot be opened as a folder: {error.strerror}")
    try:
        check_root_dir(fd, label)
        if made:
            os.fchmod(fd, 0o755)
    except BaseException:
        os.close(fd)
        raise
    return fd


class Layout:
    """/var/data/members and its home/, share/ and etc/ folders, each
    opened once and checked on the open folder."""

    def __init__(self, create):
        self.fds = {}
        parent, name = os.path.split(ROOT)
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            self.root = open_dir(name, parent_fd, ROOT, create)
        finally:
            os.close(parent_fd)
        try:
            for sub in SUBFOLDERS:
                self.fds[sub] = open_dir(sub, self.root, f"{ROOT}/{sub}", create)
        except BaseException:
            self.close()
            raise

    def close(self):
        for fd in self.fds.values():
            os.close(fd)
        os.close(self.root)

    def lock(self):
        fcntl.flock(self.root, fcntl.LOCK_EX)

    def read_users(self):
        try:
            fd = os.open(USERS, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.root)
        except FileNotFoundError:
            return {}
        except OSError as error:
            raise Refused(f"{ROOT}/{USERS} cannot be opened: {error.strerror}")
        with os.fdopen(fd, "rb") as file:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise Refused(f"{ROOT}/{USERS} is not a regular file")
            if info.st_uid != EXPECT_UID:
                raise Refused(f"{ROOT}/{USERS} is owned by uid {info.st_uid}, not root")
            if info.st_mode & 0o022:
                raise Refused(f"{ROOT}/{USERS} has group or other write")
            try:
                users = json.loads(file.read())
            except ValueError:
                raise Refused(f"{ROOT}/{USERS} is not JSON")
        if not isinstance(users, dict):
            raise Refused(f"{ROOT}/{USERS} is not a JSON object")
        return users

    def write_users(self, users):
        temporary = f".{USERS}.{os.getpid()}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=self.root)
        try:
            with os.fdopen(fd, "w") as file:
                os.fchmod(fd, 0o644)
                file.write(json.dumps(users, indent=2, sort_keys=True) + "\n")
                file.flush()
                os.fsync(fd)
            os.rename(temporary, USERS, src_dir_fd=self.root, dst_dir_fd=self.root)
        except BaseException:
            try:
                os.unlink(temporary, dir_fd=self.root)
            except FileNotFoundError:
                pass
            raise


def login_defs():
    limits = {"UID_MIN": 1000, "UID_MAX": 60000, "GID_MIN": 1000, "GID_MAX": 60000}
    try:
        with open(LOGIN_DEFS) as file:
            for line in file:
                parts = line.split()
                if len(parts) >= 2 and parts[0] in limits and parts[1].isdigit():
                    limits[parts[0]] = int(parts[1])
    except FileNotFoundError:
        pass
    return limits


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def office():
    entry = pwd.getpwnam(OFFICE_USER)
    return entry.pw_uid, entry.pw_gid


def lookup(function, key):
    try:
        return function(key)
    except KeyError:
        return None


def entry_refusal(name, entry, users):
    """Why the entry of `name` is not a member user to recreate, or None."""
    if not isinstance(name, str) or not NAME.fullmatch(name):
        return "the name is not a user name"
    if not isinstance(entry, dict) or not is_int(entry.get("uid")) or not is_int(entry.get("gid")):
        return "the entry has no uid or gid"
    if not isinstance(entry.get("locked", False), bool):
        return "locked is not true or false"
    uid, gid = entry["uid"], entry["gid"]
    office_uid, office_gid = office()
    if uid in (0, office_uid) or gid in (0, office_gid):
        return "the uid or gid is root's or the office's"
    limits = login_defs()
    if not limits["UID_MIN"] <= uid <= limits["UID_MAX"]:
        return "the uid is outside UID_MIN..UID_MAX"
    if not limits["GID_MIN"] <= gid <= limits["GID_MAX"]:
        return "the gid is outside GID_MIN..GID_MAX"
    others = [e for n, e in users.items() if n != name and isinstance(e, dict)]
    if any(e.get("uid") == uid for e in others) or any(e.get("gid") == gid for e in others):
        return "another entry has the same uid or gid"
    user = lookup(pwd.getpwnam, name)
    if user and (user.pw_uid != uid or user.pw_gid != gid):
        return "passwd has the name with another uid or gid"
    owner = lookup(pwd.getpwuid, uid)
    if owner and owner.pw_name != name:
        return f"passwd has the uid for {owner.pw_name}"
    group = lookup(grp.getgrnam, name)
    if group and group.gr_gid != gid:
        return "group has the name with another gid"
    holder = lookup(grp.getgrgid, gid)
    if holder and holder.gr_name != name:
        return f"group has the gid for {holder.gr_name}"
    return None


def stat_at(dir_fd, name):
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def make_dir(dir_fd, name, uid, gid, mode):
    os.mkdir(name, 0o700, dir_fd=dir_fd)
    fd = os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)


def remove_tree(dir_fd, name):
    info = stat_at(dir_fd, name)
    if info is None:
        return
    if stat.S_ISDIR(info.st_mode):
        shutil.rmtree(name, dir_fd=dir_fd)
    else:
        os.unlink(name, dir_fd=dir_fd)


def run(argv):
    subprocess.run(argv, check=True, stdin=subprocess.DEVNULL)


def ensure_os_user(name, uid, gid, home):
    if lookup(grp.getgrnam, name) is None:
        run(["groupadd", "-g", str(gid), name])
    if lookup(pwd.getpwnam, name) is None:
        run(["useradd", "-M", "-u", str(uid), "-g", str(gid), "-d", home, "-s", BASH, name])


def processes_of(uid):
    return subprocess.run(["pgrep", "-u", str(uid)], stdout=subprocess.DEVNULL, stdin=subprocess.DEVNULL).returncode == 0


def stop_uid(uid):
    for _ in range(40):
        if not processes_of(uid):
            return
        subprocess.run(["pkill", "-KILL", "-u", str(uid)], stdin=subprocess.DEVNULL)
        time.sleep(0.25)
    raise Refused(f"processes of uid {uid} are still running")


def run_dir(name, uid, gid):
    """/run/isomux-runner-<name>, the member's, 0711, made through a file
    descriptor."""
    folder = f"isomux-runner-{name}"
    root = os.open(RUN_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        try:
            os.mkdir(folder, 0o700, dir_fd=root)
        except FileExistsError:
            pass
        fd = os.open(folder, DIR_FLAGS, dir_fd=root)
        try:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, 0o711)
        finally:
            os.close(fd)
    finally:
        os.close(root)
    return f"{RUN_ROOT}/{folder}/runner.sock"


def start_loop(name, uid, gid):
    """The member's restart loop: the member's uid and gid, no other group, a
    fixed environment, no_new_privs, its own session, no inherited fd."""
    stop_uid(uid)
    socket = run_dir(name, uid, gid)
    home = f"{ROOT}/home/{name}"
    office_uid, _ = office()
    env = {
        "PATH": LOOP_ENV_PATH,
        "HOME": home,
        "USER": name,
        "LOGNAME": name,
        "SHELL": BASH,
        "LANG": "C.UTF-8",
    }
    subprocess.Popen(
        [SETPRIV, "--no-new-privs", "--", BASH, LOOP, f"{ROOT}/share/{name}", socket, str(office_uid)],
        user=uid,
        group=gid,
        extra_groups=[],
        env=env,
        # The child changes folder before it drops root: a path under the
        # data volume would be resolved by root. The loop does cd "$HOME" as
        # the member.
        cwd="/",
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
    )


def entry_of(users, name):
    entry = users.get(name)
    if not isinstance(entry, dict) or not is_int(entry.get("uid")) or not is_int(entry.get("gid")):
        raise Refused(f"{name} has no entry in {ROOT}/{USERS}")
    return entry


def boot():
    """Recreate each recorded member user and start its loop. A bad folder or
    file skips every member; a bad entry skips that member. The office starts
    either way: an isolated member whose runner does not connect stays
    stopped."""
    try:
        layout = Layout(create=True)
    except (Refused, OSError) as error:
        log(f"no member user starts: {error}")
        return 0
    try:
        try:
            users = layout.read_users()
        except Refused as error:
            log(f"no member user starts: {error}")
            return 0
        office_uid, _ = office()
        for name in sorted(users):
            entry = users[name]
            refusal = entry_refusal(name, entry, users)
            if refusal:
                log(f"skipped {name!r}: {refusal}")
                continue
            uid, gid = entry["uid"], entry["gid"]
            try:
                if entry.get("locked"):
                    ensure_os_user(name, uid, gid, f"{ROOT}/home/{name}")
                    run(["usermod", "--lock", "--expiredate", "1", name])
                    continue
                home = stat_at(layout.fds["home"], name)
                if home is None or not stat.S_ISDIR(home.st_mode) or home.st_uid != uid:
                    log(f"skipped {name}: its home is missing or not its own")
                    continue
                share = stat_at(layout.fds["share"], name)
                if share is None:
                    make_dir(layout.fds["share"], name, office_uid, gid, 0o2750)
                elif not stat.S_ISDIR(share.st_mode) or share.st_uid != office_uid or share.st_gid != gid:
                    log(f"skipped {name}: its share is not a folder of the office with its group")
                    continue
                ensure_os_user(name, uid, gid, f"{ROOT}/home/{name}")
                start_loop(name, uid, gid)
            except (Refused, OSError, subprocess.CalledProcessError) as error:
                log(f"skipped {name}: {error}")
        return 0
    finally:
        layout.close()


def next_id():
    """One number free as a uid and a gid, above every uid and gid in the
    file, so a uid that owns files on the volume never goes to another
    member."""
    layout = Layout(create=True)
    try:
        users = layout.read_users()
    finally:
        layout.close()
    limits = login_defs()
    taken = [limits["UID_MIN"] - 1, limits["GID_MIN"] - 1]
    for entry in users.values():
        if isinstance(entry, dict):
            taken += [v for v in (entry.get("uid"), entry.get("gid")) if is_int(v)]
    number = max(taken) + 1
    while lookup(pwd.getpwuid, number) or lookup(grp.getgrgid, number):
        number += 1
    if number > min(limits["UID_MAX"], limits["GID_MAX"]):
        raise Refused("no free uid")
    print(number)
    return 0


def add(name, uid, gid, member_id):
    """The record, the home, the share and the made mark of a new member
    user. On a failure it removes what it made."""
    if not NAME.fullmatch(name):
        raise Refused(f"{name} is not a user name")
    uid, gid = int(uid), int(gid)
    layout = Layout(create=True)
    made = []
    try:
        layout.lock()
        users = layout.read_users()
        if name in users:
            raise Refused(f"{name} is already in {ROOT}/{USERS}")
        for entry in users.values():
            if isinstance(entry, dict) and (entry.get("uid") in (uid, gid) or entry.get("gid") in (uid, gid)):
                raise Refused(f"uid {uid} or gid {gid} is already in {ROOT}/{USERS}")
        entry = {"uid": uid, "gid": gid}
        refusal = entry_refusal(name, entry, {**users, name: entry})
        if refusal:
            raise Refused(refusal)
        office_uid, _ = office()
        try:
            make_dir(layout.fds["home"], name, uid, gid, 0o700)
            made.append(("home", name))
            make_dir(layout.fds["share"], name, office_uid, gid, 0o2750)
            made.append(("share", name))
            mark = f"{name}.made"
            fd = os.open(mark, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=layout.fds["etc"])
            made.append(("etc", mark))
            with os.fdopen(fd, "w") as file:
                os.fchmod(fd, 0o600)
                file.write(member_id + "\n")
            users[name] = entry
            layout.write_users(users)
        except BaseException:
            for sub, item in reversed(made):
                remove_tree(layout.fds[sub], item)
            raise
        return 0
    finally:
        layout.close()


def start(name):
    layout = Layout(create=False)
    try:
        entry = entry_of(layout.read_users(), name)
    finally:
        layout.close()
    if entry.get("locked"):
        raise Refused(f"{name} is locked")
    start_loop(name, entry["uid"], entry["gid"])
    return 0


def stop(name):
    layout = Layout(create=False)
    try:
        entry = entry_of(layout.read_users(), name)
    finally:
        layout.close()
    stop_uid(entry["uid"])
    return 0


def lock(name):
    """disable of the last member on the user, without --delete-user: the
    entry stays, locked, so its uid is never given to a new user; the share
    goes. A later enable onto the user opens it again (unlock)."""
    layout = Layout(create=False)
    try:
        layout.lock()
        users = layout.read_users()
        entry = entry_of(users, name)
        users[name] = {**entry, "locked": True}
        layout.write_users(users)
        remove_tree(layout.fds["share"], name)
        return 0
    finally:
        layout.close()


def mark_id(layout, name):
    """The member id in the made mark of `name` (the first member the user
    was made for), or None: no mark, not a regular file, a link, or not
    root's."""
    try:
        fd = os.open(f"{name}.made", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=layout.fds["etc"])
    except OSError:
        return None
    with os.fdopen(fd) as file:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != EXPECT_UID:
            return None
        return file.read().strip()


def made_by(layout, name, member_id):
    return mark_id(layout, name) == member_id


def made_id(name):
    """Task 12c796b2: the id in the made mark of `name`; exit 1 without one.
    Several members may run as the user: the mark is the user's."""
    layout = Layout(create=False)
    try:
        found = mark_id(layout, name)
    finally:
        layout.close()
    if not found:
        return 1
    print(found)
    return 0


def unlock(name):
    """Task 12c796b2: a made user that no member runs as any more (its last
    member's disable locked the entry and removed the share) opens again for
    a new member: the lock goes and the share is made again. Only for a user
    this command made; a refusal changes nothing."""
    layout = Layout(create=False)
    try:
        layout.lock()
        users = layout.read_users()
        entry = entry_of(users, name)
        if not mark_id(layout, name):
            raise Refused(f"this command did not make {name}")
        office_uid, _ = office()
        if stat_at(layout.fds["share"], name) is None:
            make_dir(layout.fds["share"], name, office_uid, entry["gid"], 0o2750)
        users[name] = {k: v for k, v in entry.items() if k != "locked"}
        layout.write_users(users)
        return 0
    finally:
        layout.close()


def check_made(name, member_id):
    layout = Layout(create=False)
    try:
        return 0 if made_by(layout, name, member_id) else 1
    finally:
        layout.close()


def delete(name, member_id):
    """disable --delete-user, and the undo of a failed enable: the home, the
    share, the mark, then the entry. Only for a user this command made."""
    layout = Layout(create=False)
    try:
        layout.lock()
        if not made_by(layout, name, member_id):
            raise Refused(f"this command did not make {name}")
        users = layout.read_users()
        remove_tree(layout.fds["home"], name)
        remove_tree(layout.fds["share"], name)
        os.unlink(f"{name}.made", dir_fd=layout.fds["etc"])
        if name in users:
            del users[name]
            layout.write_users(users)
        return 0
    finally:
        layout.close()


VERBS = {
    "boot": (boot, 0),
    "next-id": (next_id, 0),
    "add": (add, 4),
    "start": (start, 1),
    "stop": (stop, 1),
    "lock": (lock, 1),
    "check-made": (check_made, 2),
    "made-id": (made_id, 1),
    "unlock": (unlock, 1),
    "delete": (delete, 2),
}


def main(argv):
    os.umask(0o077)
    if len(argv) < 1 or argv[0] not in VERBS or len(argv) - 1 != VERBS[argv[0]][1]:
        print(f"usage: member-users.py {{{'|'.join(VERBS)}}} ...", file=sys.stderr)
        return 2
    function, _ = VERBS[argv[0]]
    try:
        return function(*argv[1:])
    except (Refused, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        log(f"{argv[0]}: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
