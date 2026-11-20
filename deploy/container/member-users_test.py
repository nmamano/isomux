"""deploy/container/member-users.py, the root helper that recreates the
member OS users of the container (internal-docs/member-os-user-design.md,
section 1.3). Run by member-users.test.ts.

It runs as a test user: the file owner it expects is the test user's uid,
passwd and group are tables, and every external command, Popen and fchown
is recorded instead of run. The properties: a bad folder or users.json skips
every member, a bad entry skips only that member; the loop starts as the
member with nothing of root's (environment, groups, fds, session, folder);
a uid stays reserved while it owns files; every change stays inside the
checked folders, and a refusal changes nothing."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

HELPER = Path(__file__).with_name("member-users.py")
ME = os.getuid()
MY_GID = os.getgid()
# The office user's uid and gid: never the test user's, whose uid and gid
# stand for a member's (on a box where the test user is uid 1000, 1000 would
# make every member entry the office's).
OFFICE = next(n for n in (1000, 1003, 1005) if n not in (ME, MY_GID))
ALICE = "isomux-alice"


def load():
    spec = importlib.util.spec_from_file_location("member_users", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Table:
    """pwd or grp: rows of (name, id, gid)."""

    def __init__(self, rows, kind):
        self.rows, self.kind = rows, kind

    def _row(self, name, number, gid):
        if self.kind == "pwd":
            return types.SimpleNamespace(pw_name=name, pw_uid=number, pw_gid=gid)
        return types.SimpleNamespace(gr_name=name, gr_gid=number)

    def by_name(self, name):
        for row in self.rows:
            if row[0] == name:
                return self._row(*row)
        raise KeyError(name)

    def by_id(self, number):
        for row in self.rows:
            if row[1] == number:
                return self._row(*row)
        raise KeyError(number)


class Commands:
    """subprocess, recorded. `alive` pgrep answers find a process; a command
    in `failing` (or whose argv contains a `failing` string) exits 1."""

    CalledProcessError = subprocess.CalledProcessError
    DEVNULL = subprocess.DEVNULL

    def __init__(self):
        self.calls = []
        self.popens = []
        self.failing = []
        self.alive = 0

    def run(self, argv, check=False, **kwargs):
        argv = [str(a) for a in argv]
        self.calls.append(argv)
        if argv[0] == "pgrep":
            code = 0 if self.alive > 0 else 1
            self.alive -= 1
        else:
            code = 1 if any(f == argv[0] or f in argv for f in self.failing) else 0
        if check and code:
            raise subprocess.CalledProcessError(code, argv)
        return types.SimpleNamespace(returncode=code)

    def Popen(self, argv, **kwargs):
        self.calls.append(["<popen>", *argv])
        self.popens.append((list(argv), kwargs))
        return types.SimpleNamespace(pid=4242)

    def named(self, name):
        return [c for c in self.calls if c[0] == name]

    def mentions(self, text):
        return [c for c in self.calls if any(text in a for a in c)]


def snapshot(top):
    """Every entry under `top`: its type, mode and content or link target."""
    out = {}
    for base, dirs, files in os.walk(top):
        for name in dirs + files:
            path = os.path.join(base, name)
            info = os.lstat(path)
            key = os.path.relpath(path, top)
            if stat.S_ISLNK(info.st_mode):
                out[key] = ("link", os.readlink(path))
            elif stat.S_ISDIR(info.st_mode):
                out[key] = ("dir", stat.S_IMODE(info.st_mode))
            elif stat.S_ISREG(info.st_mode):
                out[key] = ("file", stat.S_IMODE(info.st_mode), Path(path).read_bytes())
            else:
                out[key] = ("other", stat.S_IMODE(info.st_mode))
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="member-users-")
        os.chmod(self.tmp, 0o755)
        self.mu = load()
        self.data = os.path.join(self.tmp, "data")
        os.mkdir(self.data, 0o755)
        self.root = os.path.join(self.data, "members")
        self.run_root = os.path.join(self.tmp, "run")
        os.mkdir(self.run_root, 0o755)
        defs = os.path.join(self.tmp, "login.defs")
        Path(defs).write_text("UID_MIN 1000\nUID_MAX 60000\nGID_MIN 1000\nGID_MAX 60000\n")
        self.mu.ROOT = self.root
        self.mu.RUN_ROOT = self.run_root
        self.mu.LOGIN_DEFS = defs
        self.mu.EXPECT_UID = ME
        self.mu.OFFICE_USER = "node"
        self.passwd = [("root", 0, 0), ("daemon", 1, 1), ("node", OFFICE, OFFICE)]
        self.groups = [("root", 0, None), ("sudo", 27, None), ("node", OFFICE, None)]
        pw, gr = Table(self.passwd, "pwd"), Table(self.groups, "grp")
        self.mu.pwd = types.SimpleNamespace(getpwnam=pw.by_name, getpwuid=pw.by_id)
        self.mu.grp = types.SimpleNamespace(getgrnam=gr.by_name, getgrgid=gr.by_id)
        self.commands = Commands()
        self.mu.subprocess = self.commands
        self.mu.time = types.SimpleNamespace(sleep=lambda seconds: None)
        # fchown as a test user: recorded with the path of the fd.
        self.chowns = []
        real_fchown = os.fchown

        def fchown(fd, uid, gid):
            self.chowns.append((os.readlink(f"/proc/self/fd/{fd}"), uid, gid))

        patcher = mock.patch.object(os, "fchown", fchown)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.real_fchown = real_fchown
        self.umask = os.umask(0o022)
        self.addCleanup(os.umask, self.umask)

    def layout(self, users=None):
        os.mkdir(self.root, 0o755)
        for sub in ("home", "share", "etc"):
            os.mkdir(os.path.join(self.root, sub), 0o755)
        if users is not None:
            self.write_users(users)

    def write_users(self, users, path=None):
        path = path or os.path.join(self.root, "users.json")
        Path(path).write_text(json.dumps(users))
        os.chmod(path, 0o644)

    def home(self, name=ALICE):
        path = os.path.join(self.root, "home", name)
        os.mkdir(path, 0o700)
        return path

    def users(self):
        return json.loads(Path(self.root, "users.json").read_text())

    def main(self, *argv):
        err, out = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = self.mu.main(list(argv))
        self.err, self.out = err.getvalue(), out.getvalue()
        return code

    def started(self):
        """The uids whose loop was started."""
        return [kwargs["user"] for _, kwargs in self.commands.popens]


class Boot(Base):
    def test_recreates_the_user_and_starts_its_loop_with_nothing_of_roots(self):
        self.layout({ALICE: {"uid": ME, "gid": MY_GID}})
        home = self.home()
        os.environ["ISOMUX_RIG_CANARY"] = "canary"
        self.addCleanup(os.environ.pop, "ISOMUX_RIG_CANARY", None)
        self.assertEqual(self.main("boot"), 0, self.err)
        self.assertIn(["groupadd", "-g", str(MY_GID), ALICE], self.commands.calls)
        self.assertIn(
            ["useradd", "-M", "-u", str(ME), "-g", str(MY_GID), "-d", home, "-s", "/bin/bash", ALICE],
            self.commands.calls,
        )
        share = os.path.join(self.root, "share", ALICE)
        self.assertEqual(stat.S_IMODE(os.lstat(share).st_mode), 0o2750)
        self.assertIn((share, OFFICE, MY_GID), self.chowns)
        run_dir = os.path.join(self.run_root, f"isomux-runner-{ALICE}")
        self.assertEqual(stat.S_IMODE(os.lstat(run_dir).st_mode), 0o711)
        self.assertIn((run_dir, ME, MY_GID), self.chowns)
        # The home is the member's: never chowned by root.
        self.assertNotIn(home, [path for path, _, _ in self.chowns])

        self.assertEqual(len(self.commands.popens), 1)
        argv, kwargs = self.commands.popens[0]
        self.assertEqual(
            argv,
            [self.mu.SETPRIV, "--no-new-privs", "--", self.mu.BASH, self.mu.LOOP,
             share, os.path.join(run_dir, "runner.sock"), str(OFFICE)],
        )
        self.assertEqual((kwargs["user"], kwargs["group"], kwargs["extra_groups"]), (ME, MY_GID, []))
        # L1: a fixed environment, nothing inherited.
        self.assertEqual(
            kwargs["env"],
            {"PATH": self.mu.LOOP_ENV_PATH, "HOME": home, "USER": ALICE, "LOGNAME": ALICE,
             "SHELL": "/bin/bash", "LANG": "C.UTF-8"},
        )
        # L2: no fd of root's, its own session.
        for stream in ("stdin", "stdout", "stderr"):
            self.assertEqual(kwargs[stream], subprocess.DEVNULL, stream)
        self.assertIs(kwargs["close_fds"], True)
        self.assertIs(kwargs["start_new_session"], True)
        self.assertFalse(kwargs.get("pass_fds"))
        self.assertIsNone(kwargs.get("preexec_fn"))
        # Root changes its folder before it drops to the member, so the start
        # folder is never a path under the data volume, which the office user
        # can replace: the loop changes to $HOME as the member.
        self.assertEqual(kwargs["cwd"], "/")

    def test_a_user_that_passwd_has_already_is_not_made_again(self):
        # docker restart keeps passwd: boot again finds the user.
        self.layout({ALICE: {"uid": ME, "gid": MY_GID}})
        self.home()
        self.passwd.append((ALICE, ME, MY_GID))
        self.groups.append((ALICE, MY_GID, None))
        self.assertEqual(self.main("boot"), 0, self.err)
        self.assertEqual(self.commands.named("groupadd") + self.commands.named("useradd"), [])
        self.assertEqual(self.started(), [ME])

    def test_makes_a_missing_members_folder_root_0755(self):
        self.assertEqual(self.main("boot"), 0, self.err)
        for path in [self.root] + [os.path.join(self.root, s) for s in ("home", "share", "etc")]:
            self.assertEqual(stat.S_IMODE(os.lstat(path).st_mode), 0o755, path)
        self.assertEqual(self.commands.calls, [])

    def test_a_bad_folder_or_users_file_skips_every_member(self):
        elsewhere = os.path.join(self.tmp, "elsewhere")

        def good_copy():
            os.mkdir(elsewhere, 0o755)
            for sub in ("home", "share", "etc"):
                os.mkdir(os.path.join(elsewhere, sub), 0o755)
            os.mkdir(os.path.join(elsewhere, "home", ALICE), 0o700)
            self.write_users({ALICE: {"uid": ME, "gid": MY_GID}}, os.path.join(elsewhere, "users.json"))

        def members_link():
            shutil.rmtree(self.root)
            good_copy()
            os.symlink(elsewhere, self.root)

        def sub_link(sub):
            def change():
                shutil.rmtree(os.path.join(self.root, sub))
                good_copy()
                os.symlink(os.path.join(elsewhere, sub), os.path.join(self.root, sub))
            return change

        def users_link():
            good_copy()
            os.unlink(os.path.join(self.root, "users.json"))
            os.symlink(os.path.join(elsewhere, "users.json"), os.path.join(self.root, "users.json"))

        def chmod(path, mode):
            return lambda: os.chmod(os.path.join(self.root, path), mode)

        def replace_users(content):
            def change():
                Path(self.root, "users.json").write_text(content)
            return change

        def users_fifo():
            os.unlink(os.path.join(self.root, "users.json"))
            os.mkfifo(os.path.join(self.root, "users.json"), 0o644)

        def etc_file():
            os.rmdir(os.path.join(self.root, "etc"))
            Path(self.root, "etc").write_text("")

        def not_root_owner():
            self.mu.EXPECT_UID = ME + 1

        cases = {
            "the members folder is a link": members_link,
            "home/ is a link": sub_link("home"),
            "share/ is a link": sub_link("share"),
            "etc/ is a link": sub_link("etc"),
            "etc/ is a file": etc_file,
            "the members folder has group write": chmod(".", 0o775),
            "the members folder has other write": chmod(".", 0o757),
            "home/ has group write": chmod("home", 0o775),
            "share/ has other write": chmod("share", 0o757),
            "etc/ has group write": chmod("etc", 0o775),
            "the members folder is not root's": not_root_owner,
            "users.json is a link": users_link,
            "users.json has group write": chmod("users.json", 0o664),
            "users.json has other write": chmod("users.json", 0o646),
            "users.json is a FIFO": users_fifo,
            "users.json is not JSON": replace_users("{"),
            "users.json is not an object": replace_users(json.dumps([{"uid": ME, "gid": MY_GID}])),
        }
        for label, change in cases.items():
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                if os.path.islink(self.root):
                    os.unlink(self.root)
                shutil.rmtree(elsewhere, ignore_errors=True)
                self.mu.EXPECT_UID = ME
                self.commands.calls.clear()
                self.commands.popens.clear()
                self.layout({ALICE: {"uid": ME, "gid": MY_GID}})
                self.home()
                change()
                before = snapshot(self.tmp)
                self.assertEqual(self.main("boot"), 0)
                self.assertEqual(self.commands.calls, [], label)
                self.assertIn("[member-users]", self.err)
                self.assertEqual(snapshot(self.tmp), before)

    def test_a_bad_entry_skips_that_member_only(self):
        bad = "isomux-bad"
        cases = {
            "uid 0": {"uid": 0, "gid": 1600},
            "gid 0": {"uid": 1600, "gid": 0},
            "the office's uid": {"uid": OFFICE, "gid": 1600},
            "the office's gid": {"uid": 1600, "gid": OFFICE},
            "uid below UID_MIN": {"uid": 999, "gid": 1600},
            "uid above UID_MAX": {"uid": 60001, "gid": 1600},
            "gid below GID_MIN": {"uid": 1600, "gid": 999},
            "gid above GID_MAX": {"uid": 1600, "gid": 60001},
            "uid a bool": {"uid": True, "gid": 1600},
            "uid a string": {"uid": "1600", "gid": 1600},
            "gid a float": {"uid": 1600, "gid": 1600.0},
            "no gid": {"uid": 1600},
            "not an object": [1600, 1600],
            "locked not a bool": {"uid": 1600, "gid": 1600, "locked": "yes"},
            "passwd has the name with another uid": ("passwd", (bad, 1700, 1600), {"uid": 1600, "gid": 1600}),
            "passwd has the name with another gid": ("passwd", (bad, 1600, 1700), {"uid": 1600, "gid": 1600}),
            "passwd has the uid for another name": ("passwd", ("someone", 1600, 1700), {"uid": 1600, "gid": 1600}),
            "group has the name with another gid": ("group", (bad, 1700, None), {"uid": 1600, "gid": 1600}),
            "group has the gid for another name": ("group", ("staff2", 1600, None), {"uid": 1600, "gid": 1600}),
        }
        names = {"a name that is not a user name": "Bad Name", "a name with a leading dash": "-bad"}
        runs = [(label, bad, entry) for label, entry in cases.items()]
        runs += [(label, name, {"uid": 1600, "gid": 1600}) for label, name in names.items()]
        for label, name, entry in runs:
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                del self.passwd[3:]
                del self.groups[3:]
                self.commands.calls.clear()
                self.commands.popens.clear()
                if isinstance(entry, tuple):
                    table, row, entry = entry
                    (self.passwd if table == "passwd" else self.groups).append(row)
                self.layout({ALICE: {"uid": ME, "gid": MY_GID}, name: entry})
                self.home()
                self.assertEqual(self.main("boot"), 0, self.err)
                self.assertEqual(self.started(), [ME], label)
                self.assertEqual(self.commands.mentions(name), [], label)
                self.assertIn(repr(name), self.err)

    def test_two_entries_with_one_uid_or_gid_are_both_skipped(self):
        for other in ({"uid": ME, "gid": 1600}, {"uid": 1600, "gid": MY_GID}):
            with self.subTest(other):
                shutil.rmtree(self.root, ignore_errors=True)
                self.commands.calls.clear()
                self.commands.popens.clear()
                self.layout({ALICE: {"uid": ME, "gid": MY_GID}, "isomux-bob": other})
                self.home()
                self.assertEqual(self.main("boot"), 0)
                self.assertEqual(self.commands.calls, [])

    def test_a_home_or_share_that_is_not_the_members_skips_that_member(self):
        def home_link():
            target = os.path.join(self.tmp, "target")
            os.mkdir(target, 0o700)
            os.symlink(target, os.path.join(self.root, "home", ALICE))

        def home_file():
            Path(self.root, "home", ALICE).write_text("")

        def share_of(make):
            def change():
                self.home()
                make(os.path.join(self.root, "share", ALICE))
            return change

        def share_link(path):
            target = os.path.join(self.tmp, "target")
            os.mkdir(target, 0o750)
            os.symlink(target, path)

        cases = {
            # The entry's uid is not the test user's, who owns the home.
            "the home is another uid's": (1600, self.home),
            "the home is missing": (ME, lambda: None),
            "the home is a link": (ME, home_link),
            "the home is a file": (ME, home_file),
            # The test user owns the share, not the office (uid 1000).
            "the share is not the office's": (ME, share_of(lambda p: os.mkdir(p, 0o2750))),
            "the share is a link": (ME, share_of(share_link)),
            "the share is a file": (ME, share_of(lambda p: Path(p).write_text(""))),
        }
        for label, (uid, change) in cases.items():
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                shutil.rmtree(os.path.join(self.tmp, "target"), ignore_errors=True)
                self.commands.calls.clear()
                self.commands.popens.clear()
                self.chowns.clear()
                self.layout({ALICE: {"uid": uid, "gid": MY_GID}})
                change()
                before = snapshot(self.tmp)
                self.assertEqual(self.main("boot"), 0)
                self.assertEqual(self.commands.popens, [], label)
                self.assertEqual(self.chowns, [], label)
                self.assertEqual(snapshot(self.tmp), before, label)

    def test_a_locked_entry_with_its_own_home_runs_nothing(self):
        self.layout({ALICE: {"uid": ME, "gid": MY_GID, "locked": True}})
        self.home()
        self.assertEqual(self.main("boot"), 0, self.err)
        self.assertIn(["usermod", "--lock", "--expiredate", "1", ALICE], self.commands.calls)
        self.assertEqual(self.commands.popens, [])

    def test_a_locked_entry_is_recreated_locked_and_runs_nothing(self):
        # No home is needed: a locked member's home may be gone.
        self.layout({ALICE: {"uid": 1600, "gid": 1600, "locked": True}})
        self.assertEqual(self.main("boot"), 0, self.err)
        self.assertIn(["groupadd", "-g", "1600", ALICE], self.commands.calls)
        self.assertEqual(self.commands.named("useradd")[0][:5], ["useradd", "-M", "-u", "1600", "-g"])
        self.assertIn(["usermod", "--lock", "--expiredate", "1", ALICE], self.commands.calls)
        self.assertEqual(self.commands.popens, [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "share", ALICE)))

    def test_one_failing_member_does_not_stop_the_next(self):
        self.layout({"isomux-a": {"uid": 1600, "gid": 1600, "locked": True}, "isomux-b": {"uid": ME, "gid": MY_GID}})
        self.home("isomux-b")
        self.commands.failing = ["usermod"]
        self.assertEqual(self.main("boot"), 0)
        self.assertEqual(self.started(), [ME])
        self.assertIn("isomux-a", self.err)


class NextId(Base):
    def test_above_every_recorded_number_also_of_bad_entries(self):
        self.layout({
            "isomux-a": {"uid": 1500, "gid": 1700, "locked": True},
            "Bad Name": {"uid": 1900, "gid": 1901},
            "isomux-c": {"uid": "5000", "gid": 1200.0},
        })
        self.assertEqual(self.main("next-id"), 0, self.err)
        self.assertEqual(self.out, "1902\n")

    def test_steps_past_a_uid_or_gid_that_passwd_or_group_has(self):
        self.layout({"isomux-a": {"uid": 1500, "gid": 1501}})
        self.passwd.append(("x", 1502, 1))
        self.groups.append(("y", 1503, None))
        self.assertEqual(self.main("next-id"), 0, self.err)
        self.assertEqual(self.out, "1504\n")

    def test_with_no_record_it_is_the_first_free_from_uid_min(self):
        self.assertEqual(self.main("next-id"), 0, self.err)
        # UID_MIN, or the next number when the office user (node) has it.
        self.assertEqual(self.out, f"{1001 if OFFICE == 1000 else 1000}\n")

    def test_refuses_past_uid_max(self):
        self.layout({"isomux-a": {"uid": 60000, "gid": 60000}})
        self.assertEqual(self.main("next-id"), 1)
        self.assertEqual(self.out, "")

    def test_refuses_a_bad_users_file(self):
        self.layout({"isomux-a": {"uid": 1500, "gid": 1501}})
        os.chmod(os.path.join(self.root, "users.json"), 0o664)
        self.assertEqual(self.main("next-id"), 1)
        self.assertEqual(self.out, "")


class Add(Base):
    def test_makes_the_home_the_share_the_mark_and_the_entry(self):
        self.layout({"isomux-bob": {"uid": 1500, "gid": 1500}})
        self.assertEqual(self.main("add", ALICE, "1600", "1601", "u-alice"), 0, self.err)
        home = os.path.join(self.root, "home", ALICE)
        share = os.path.join(self.root, "share", ALICE)
        mark = os.path.join(self.root, "etc", f"{ALICE}.made")
        self.assertEqual(stat.S_IMODE(os.lstat(home).st_mode), 0o700)
        self.assertIn((home, 1600, 1601), self.chowns)
        self.assertEqual(stat.S_IMODE(os.lstat(share).st_mode), 0o2750)
        self.assertIn((share, OFFICE, 1601), self.chowns)
        self.assertEqual(stat.S_IMODE(os.lstat(mark).st_mode), 0o600)
        self.assertEqual(Path(mark).read_text().strip(), "u-alice")
        self.assertEqual(self.users(), {"isomux-bob": {"uid": 1500, "gid": 1500}, ALICE: {"uid": 1600, "gid": 1601}})
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(self.root, "users.json")).st_mode), 0o644)
        self.assertEqual(sorted(os.listdir(self.root)), ["etc", "home", "share", "users.json"])

    def test_refuses_a_name_uid_or_gid_already_recorded_and_changes_nothing(self):
        cases = {
            "the name": (ALICE, "1700", "1700"),
            "the uid as a uid": ("isomux-new", "1600", "1700"),
            "the uid as a gid": ("isomux-new", "1700", "1600"),
            "the gid as a uid": ("isomux-new", "1601", "1700"),
            "the gid as a gid": ("isomux-new", "1700", "1601"),
        }
        for label, (name, uid, gid) in cases.items():
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                self.layout({ALICE: {"uid": 1600, "gid": 1601, "locked": True}})
                before = snapshot(self.tmp)
                self.assertEqual(self.main("add", name, uid, gid, "u-new"), 1)
                self.assertEqual(snapshot(self.tmp), before, label)

    def test_refuses_an_entry_that_boot_would_skip(self):
        for uid, gid in (("0", "1600"), (str(OFFICE), "1600"), ("1600", str(OFFICE)), ("70000", "1600")):
            with self.subTest((uid, gid)):
                shutil.rmtree(self.root, ignore_errors=True)
                self.layout({})
                before = snapshot(self.tmp)
                self.assertEqual(self.main("add", ALICE, uid, gid, "u-alice"), 1)
                self.assertEqual(snapshot(self.tmp), before)

    def test_never_takes_over_a_home_or_mark_that_exists_and_removes_what_it_made(self):
        def stale_home():
            os.mkdir(os.path.join(self.root, "home", ALICE), 0o755)
            Path(self.root, "home", ALICE, "planted").write_text("x")

        def stale_mark():
            Path(self.root, "etc", f"{ALICE}.made").write_text("u-other\n")

        def share_link():
            os.mkdir(os.path.join(self.tmp, "target"), 0o755)
            os.symlink(os.path.join(self.tmp, "target"), os.path.join(self.root, "share", ALICE))

        for label, change in {"a home": stale_home, "a mark": stale_mark, "a share link": share_link}.items():
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                shutil.rmtree(os.path.join(self.tmp, "target"), ignore_errors=True)
                self.layout({})
                change()
                before = snapshot(self.tmp)
                self.assertEqual(self.main("add", ALICE, "1600", "1600", "u-alice"), 1)
                self.assertEqual(snapshot(self.tmp), before, label)

    def test_refuses_a_members_folder_that_is_not_roots_before_any_record(self):
        # No users.json yet: the folder check alone must refuse.
        self.layout()
        self.mu.EXPECT_UID = ME + 1
        before = snapshot(self.tmp)
        self.assertEqual(self.main("add", ALICE, "1600", "1600", "u-alice"), 1)
        self.assertEqual(snapshot(self.tmp), before)
        self.assertEqual(self.main("next-id"), 1)
        self.assertEqual(self.out, "")

    def test_refuses_through_a_members_folder_that_is_a_link(self):
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.mkdir(elsewhere, 0o755)
        for sub in ("home", "share", "etc"):
            os.mkdir(os.path.join(elsewhere, sub), 0o755)
        os.symlink(elsewhere, self.root)
        before = snapshot(self.tmp)
        self.assertEqual(self.main("add", ALICE, "1600", "1600", "u-alice"), 1)
        self.assertEqual(snapshot(self.tmp), before)
        self.assertEqual(self.chowns, [])


class LockAndDelete(Base):
    def made(self, member_id="u-alice"):
        self.layout({ALICE: {"uid": 1600, "gid": 1600}, "isomux-bob": {"uid": 1500, "gid": 1500}})
        self.home()
        os.mkdir(os.path.join(self.root, "share", ALICE), 0o750)
        Path(self.root, "share", ALICE, "runtime").write_text("x")
        mark = Path(self.root, "etc", f"{ALICE}.made")
        mark.write_text(member_id + "\n")
        os.chmod(mark, 0o600)

    def test_lock_keeps_the_entry_locked_and_the_home_and_removes_the_share(self):
        self.made()
        self.assertEqual(self.main("lock", ALICE), 0, self.err)
        self.assertEqual(self.users()[ALICE], {"uid": 1600, "gid": 1600, "locked": True})
        self.assertEqual(self.users()["isomux-bob"], {"uid": 1500, "gid": 1500})
        self.assertTrue(os.path.isdir(os.path.join(self.root, "home", ALICE)))
        self.assertFalse(os.path.lexists(os.path.join(self.root, "share", ALICE)))

    def test_delete_removes_the_home_the_share_the_mark_and_the_entry_without_following_links(self):
        self.made()
        outside = os.path.join(self.tmp, "outside")
        os.mkdir(outside, 0o755)
        Path(outside, "keep").write_text("x")
        os.symlink(outside, os.path.join(self.root, "home", ALICE, "link"))
        self.assertEqual(self.main("delete", ALICE, "u-alice"), 0, self.err)
        for path in (("home", ALICE), ("share", ALICE), ("etc", f"{ALICE}.made")):
            self.assertFalse(os.path.lexists(os.path.join(self.root, *path)), path)
        self.assertEqual(self.users(), {"isomux-bob": {"uid": 1500, "gid": 1500}})
        self.assertTrue(Path(outside, "keep").exists())

    def test_delete_refuses_a_user_it_did_not_make_for_this_member_and_changes_nothing(self):
        def other_member():
            Path(self.root, "etc", f"{ALICE}.made").write_text("u-other\n")

        def no_mark():
            os.unlink(os.path.join(self.root, "etc", f"{ALICE}.made"))

        def mark_link():
            target = os.path.join(self.tmp, "mark")
            Path(target).write_text("u-alice\n")
            os.unlink(os.path.join(self.root, "etc", f"{ALICE}.made"))
            os.symlink(target, os.path.join(self.root, "etc", f"{ALICE}.made"))

        for label, change in {"another member": other_member, "no mark": no_mark, "a link": mark_link}.items():
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                if os.path.lexists(os.path.join(self.tmp, "mark")):
                    os.unlink(os.path.join(self.tmp, "mark"))
                self.made()
                change()
                before = snapshot(self.tmp)
                self.assertEqual(self.main("delete", ALICE, "u-alice"), 1)
                self.assertEqual(snapshot(self.tmp), before, label)
                self.assertEqual(self.main("check-made", ALICE, "u-alice"), 1)

    def test_check_made_answers_the_mark_of_this_member(self):
        self.made()
        self.assertEqual(self.main("check-made", ALICE, "u-alice"), 0)
        self.assertEqual(self.main("check-made", ALICE, "u-other"), 1)


class SharedUser(Base):
    """Task 12c796b2: several members on one user. made-id names the member
    in the mark (the first one on the user); unlock reopens a locked entry
    for a new member: the lock goes, and the share is made again."""

    def made(self, member_id="u-first", locked=False):
        entry = {"uid": 1600, "gid": 1600, **({"locked": True} if locked else {})}
        self.layout({ALICE: entry, "isomux-bob": {"uid": 1500, "gid": 1500}})
        self.home()
        mark = Path(self.root, "etc", f"{ALICE}.made")
        mark.write_text(member_id + "\n")
        os.chmod(mark, 0o600)

    def test_made_id_prints_the_id_in_the_mark(self):
        self.made("u-first")
        self.assertEqual(self.main("made-id", ALICE), 0, self.err)
        self.assertEqual(self.out.strip(), "u-first")

    def test_made_id_fails_with_no_mark_or_a_link(self):
        def no_mark():
            os.unlink(os.path.join(self.root, "etc", f"{ALICE}.made"))

        def mark_link():
            target = os.path.join(self.tmp, "mark")
            Path(target).write_text("u-first\n")
            os.unlink(os.path.join(self.root, "etc", f"{ALICE}.made"))
            os.symlink(target, os.path.join(self.root, "etc", f"{ALICE}.made"))

        for label, change in {"no mark": no_mark, "a link": mark_link}.items():
            with self.subTest(label):
                shutil.rmtree(self.root, ignore_errors=True)
                if os.path.lexists(os.path.join(self.tmp, "mark")):
                    os.unlink(os.path.join(self.tmp, "mark"))
                self.made()
                change()
                self.assertEqual(self.main("made-id", ALICE), 1)
                self.assertEqual(self.out.strip(), "")

    def test_unlock_clears_the_lock_and_makes_the_share_so_start_runs(self):
        self.made(locked=True)
        # The enabling condition: a locked entry does not start.
        self.assertEqual(self.main("start", ALICE), 1)
        self.assertEqual(self.main("unlock", ALICE), 0, self.err)
        self.assertEqual(self.users()[ALICE], {"uid": 1600, "gid": 1600})
        self.assertEqual(self.users()["isomux-bob"], {"uid": 1500, "gid": 1500})
        share = os.path.join(self.root, "share", ALICE)
        self.assertEqual(stat.S_IMODE(os.lstat(share).st_mode), 0o2750)
        self.assertIn((share, OFFICE, 1600), self.chowns)
        self.assertEqual(Path(self.root, "etc", f"{ALICE}.made").read_text(), "u-first\n")

    def test_unlock_refuses_an_unknown_user_or_one_with_no_mark(self):
        self.made(locked=True)
        self.assertEqual(self.main("unlock", "isomux-nobody"), 1)
        os.unlink(os.path.join(self.root, "etc", f"{ALICE}.made"))
        before = snapshot(self.tmp)
        self.assertEqual(self.main("unlock", ALICE), 1)
        self.assertEqual(snapshot(self.tmp), before)


class StartAndStop(Base):
    def setUp(self):
        super().setUp()
        self.layout({ALICE: {"uid": ME, "gid": MY_GID}, "isomux-old": {"uid": 1500, "gid": 1500, "locked": True}})
        self.home()

    def test_start_stops_what_runs_first(self):
        self.commands.alive = 2
        self.assertEqual(self.main("start", ALICE), 0, self.err)
        kill = self.commands.calls.index(["pkill", "-KILL", "-u", str(ME)])
        popen = next(i for i, c in enumerate(self.commands.calls) if c[0] == "<popen>")
        self.assertLess(kill, popen)
        self.assertEqual(self.commands.named("pgrep")[-1], ["pgrep", "-u", str(ME)])

    def test_start_refuses_a_locked_or_unknown_user(self):
        for name in ("isomux-old", "isomux-nobody"):
            with self.subTest(name):
                self.assertEqual(self.main("start", name), 1)
                self.assertEqual(self.commands.popens, [])

    def test_start_refuses_a_run_folder_that_is_a_link(self):
        target = os.path.join(self.tmp, "target")
        os.mkdir(target, 0o700)
        os.symlink(target, os.path.join(self.run_root, f"isomux-runner-{ALICE}"))
        self.assertEqual(self.main("start", ALICE), 1)
        self.assertEqual(self.commands.popens, [])
        self.assertEqual(self.chowns, [])
        self.assertEqual(stat.S_IMODE(os.lstat(target).st_mode), 0o700)

    def test_stop_and_start_refuse_while_processes_stay(self):
        for verb in ("stop", "start"):
            with self.subTest(verb):
                self.commands.alive = 10**6
                self.commands.calls.clear()
                self.assertEqual(self.main(verb, ALICE), 1)
                self.assertEqual(self.commands.popens, [])
                self.assertTrue(self.commands.named("pkill"))

    def test_stop_kills_every_process_of_the_uid(self):
        self.commands.alive = 1
        self.assertEqual(self.main("stop", ALICE), 0, self.err)
        self.assertIn(["pkill", "-KILL", "-u", str(ME)], self.commands.calls)


class Main(Base):
    def test_sets_umask_077_and_answers_2_to_a_bad_call(self):
        self.assertEqual(self.main("add", ALICE), 2)
        self.assertEqual(self.main("nothing"), 2)
        self.assertEqual(self.main(), 2)
        self.assertEqual(os.umask(0o022), 0o077)


if __name__ == "__main__":
    unittest.main()
