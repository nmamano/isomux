import hashlib
import io
import json
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import publish

REVISION = "a" * 40
TAG = "v2026.9.21"


def response(raw, digest=None):
    result = io.BytesIO(raw)
    result.headers = {"Docker-Content-Digest": digest or "sha256:" + hashlib.sha256(raw).hexdigest()}
    return result


def manifests(revision=REVISION, architecture="amd64"):
    config = json.dumps({"os": "linux", "architecture": architecture,
                         "config": {"Labels": {"org.opencontainers.image.revision": revision}}}).encode()
    manifest = json.dumps({"config": {"digest": "sha256:" + hashlib.sha256(config).hexdigest()}}).encode()
    return [response(manifest), response(config)]


class PublicationTests(unittest.TestCase):
    def test_only_404_means_absent(self):
        for status in (401, 403, 404, 429, 500):
            with self.subTest(status=status), patch.object(publish, "request", side_effect=
                    urllib.error.HTTPError("https://ghcr.io", status, "fixture", {}, None)):
                if status == 404:
                    self.assertIsNone(publish.existing_digest(TAG, REVISION, "fixture"))
                else:
                    with self.assertRaises(urllib.error.HTTPError):
                        publish.existing_digest(TAG, REVISION, "fixture")

    def test_network_error_is_not_absence(self):
        with patch.object(publish, "request", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                publish.existing_digest(TAG, REVISION, "fixture")

    def test_existing_image_matches_source_and_platform(self):
        with patch.object(publish, "request", side_effect=manifests()):
            self.assertRegex(publish.existing_digest(TAG, REVISION, "fixture"), r"^sha256:[a-f0-9]{64}$")
        for args in (("b" * 40, "amd64"), (REVISION, "arm64")):
            with patch.object(publish, "request", side_effect=manifests(*args)):
                with self.assertRaises(ValueError):
                    publish.existing_digest(TAG, REVISION, "fixture")

    def test_bad_manifest_digest_is_refused(self):
        with patch.object(publish, "request", return_value=response(b"{}", "sha256:bad")):
            with self.assertRaises(ValueError):
                publish.existing_digest(TAG, REVISION, "fixture")

    def test_buildkit_index_returns_root_digest_after_checking_child(self):
        child, config = manifests()
        index = json.dumps({"manifests": [
            {"digest": child.headers["Docker-Content-Digest"],
             "platform": {"os": "linux", "architecture": "amd64"}},
            {"digest": "sha256:" + "b" * 64,
             "platform": {"os": "unknown", "architecture": "unknown"}},
        ]}).encode()
        with patch.object(publish, "request", side_effect=[response(index), child, config]):
            self.assertEqual(publish.existing_digest(TAG, REVISION, "fixture"),
                             "sha256:" + hashlib.sha256(index).hexdigest())

    def test_index_without_amd64_is_refused(self):
        with patch.object(publish, "request", return_value=response(b'{"manifests": []}')):
            with self.assertRaises(ValueError):
                publish.existing_digest(TAG, REVISION, "fixture")

    def test_bad_config_digest_is_refused(self):
        replies = manifests()
        replies[1] = response(b"{}")
        with patch.object(publish, "request", side_effect=replies):
            with self.assertRaises(ValueError):
                publish.existing_digest(TAG, REVISION, "fixture")

    def test_cross_host_redirect_strips_token(self):
        handler = publish.RegistryRedirect()
        req = urllib.request.Request("https://ghcr.io/blob", headers={"Authorization": "fixture"})
        redirected = handler.redirect_request(req, None, 302, "", {}, "https://storage.example/blob")
        self.assertIsNone(redirected.get_header("Authorization"))
        with self.assertRaises(ValueError):
            handler.redirect_request(req, None, 302, "", {}, "http://storage.example/blob")

    @patch.object(publish.subprocess, "run")
    @patch.object(publish, "registry_token", return_value="fixture")
    def test_retry_keeps_original_digest_without_push(self, token, run):
        with patch.object(publish, "existing_digest", return_value="sha256:original"):
            self.assertEqual(publish.publish(TAG, REVISION, "local", "actor", "secret"),
                             publish.IMAGE + "@sha256:original")
        run.assert_not_called()

    @patch.object(publish.subprocess, "run")
    @patch.object(publish, "registry_token", return_value="fixture")
    def test_new_tag_pushes_once_and_records_registry_digest(self, token, run):
        with patch.object(publish, "existing_digest", side_effect=[None, "sha256:new"]):
            self.assertEqual(publish.publish(TAG, REVISION, "local", "actor", "secret"),
                             publish.IMAGE + "@sha256:new")
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[1], ["docker", "tag", "local", publish.IMAGE + ":" + TAG])
        self.assertEqual(commands[2], ["docker", "push", publish.IMAGE + ":" + TAG])
        self.assertEqual(commands[3], ["docker", "logout", "ghcr.io"])
        self.assertNotIn("secret", str(commands))

    @patch.object(publish.subprocess, "run")
    @patch.object(publish, "registry_token", return_value="fixture")
    def test_collision_never_pushes(self, token, run):
        with patch.object(publish, "existing_digest", side_effect=ValueError):
            with self.assertRaises(ValueError):
                publish.publish(TAG, REVISION, "local", "actor", "secret")
        run.assert_not_called()

    @patch.object(publish, "registry_token")
    def test_invalid_identity_never_authenticates(self, token):
        for tag, revision in (("latest", REVISION), (TAG, "main"), ("v2026.9.21;echo bad", REVISION)):
            with self.assertRaises(ValueError):
                publish.publish(tag, revision, "local", "actor", "secret")
        token.assert_not_called()


if __name__ == "__main__":
    unittest.main()
