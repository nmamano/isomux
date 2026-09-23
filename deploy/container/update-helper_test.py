import importlib.util
import json
from pathlib import Path
import types
import unittest

spec = importlib.util.spec_from_file_location("helper", Path(__file__).with_name("update-helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Requests(unittest.TestCase):
    def test_fixed_operation_and_environment(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return types.SimpleNamespace(returncode=0)
        self.assertTrue(helper.request(b'{"tag":"v2099.1.2"}\n', run))
        self.assertEqual(calls[0][0], ["/usr/bin/systemctl", "start", "--no-block", "isomux-update@v2099.1.2.service"])
        self.assertEqual(calls[0][1]["env"], {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/root"})
        self.assertEqual(len(calls), 1)

    def test_malformed_requests_never_launch(self):
        bad = [b'{}\n', b'[]\n', b'null\n', b'{"tag":5}\n', b'{"tag":"v2099.1.2"}',
               b'{"tag":"v2099.1.2","tag":"v2099.1.2"}\n', b' ' * 257 + b'\n',
               b'{"tag":"v2099.1.2"}\n{}\n', b'\xff\n']
        bad.append(b' ' * 237 + b'{"tag":"v2099.1.2"}\n')  # 257 bytes, valid JSON
        for tag in ["main", "v2099.1.2\n", "v2099.1.2/../../x", "v2099.1.2;id", "v2099.1.2.service", "v2099.1.2 other.service", "$(id)"]:
            bad.append((json.dumps({"tag": tag}) + "\n").encode())
        for key in ["command", "path", "unit", "docker", "operation"]:
            bad.append((json.dumps({"tag": "v2099.1.2", key: "ignored"}) + "\n").encode())
        def forbidden(*args, **kwargs):
            self.fail("malformed request launched an operation")
        for raw in bad:
            with self.subTest(raw=raw):
                self.assertFalse(helper.request(raw, forbidden))

    def test_launch_failure_is_not_acceptance(self):
        self.assertFalse(helper.request(b'{"tag":"v2099.1.2"}\n', lambda *a, **k: types.SimpleNamespace(returncode=1)))


if __name__ == "__main__":
    unittest.main()
