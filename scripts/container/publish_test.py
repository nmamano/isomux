import gzip
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
import urllib.parse
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


def index(*children):
    return json.dumps({"manifests": [
        {"digest": child, "platform": {"os": "linux", "architecture": architecture}}
        for architecture, child in children]}).encode()


RELEASE_IDENTITY = {"release": TAG, "commit": REVISION}


def fake_save(architecture="amd64", revision=REVISION, diff_ids=None, compressed=False,
              store="classic", image_id=None, identity=RELEASE_IDENTITY):
    """Stand-ins for `docker image inspect`, the identity run and `docker save`.

    The saved archive is Docker 25+'s layout: legacy manifest.json plus
    content-addressed blobs. In the containerd store the image ID names a
    manifest; in the classic store it is the config digest.
    """
    layers = [b"layer-one" * 1000, b"layer-two"]
    config = json.dumps({"os": "linux", "architecture": architecture,
                         "config": {"Labels": {"org.opencontainers.image.revision": revision}},
                         "rootfs": {"type": "layers", "diff_ids": diff_ids or [
                             "sha256:" + hashlib.sha256(layer).hexdigest() for layer in layers]}}).encode()
    config_digest = "sha256:" + hashlib.sha256(config).hexdigest()
    manifest = json.dumps({"config": {"digest": config_digest}, "layers": []}).encode()
    manifest_digest = "sha256:" + hashlib.sha256(manifest).hexdigest()
    gated = image_id or (config_digest if store == "classic" else manifest_digest)

    def run(command, **kwargs):
        if command[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess([], 0, stdout=gated + "\n")
        if command[:2] == ["docker", "run"]:
            assert gated in command
            return subprocess.CompletedProcess([], 0, stdout=json.dumps(identity))
        assert command[:3] == ["docker", "save", "-o"] and command[4] == gated
        with tarfile.open(command[3], "w") as archive:
            config_path = "blobs/sha256/" + config_digest[7:]
            files = {"manifest.json": json.dumps([{"Config": config_path,
                                                   "Layers": ["one.tar", "two.tar"]}]).encode(),
                     config_path: config,
                     "blobs/sha256/" + manifest_digest[7:]: manifest,
                     "one.tar": gzip.compress(layers[0]) if compressed else layers[0],
                     "two.tar": layers[1]}
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        return subprocess.CompletedProcess([], 0)
    return run


REGISTRY = publish.Registry("registry.test/image", "api", "fixture", "/auth.json", True)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())

    def test_built_image_identity_is_required_before_the_layout_is_written(self):
        # The save stand-in writes a valid image, so only the identity check can
        # stop the layout; each case gets its own directory.
        cases = ((TAG, {}), (TAG, {"release": None, "commit": REVISION}),
                 (TAG, {"release": TAG, "commit": None}),
                 (TAG, {"release": "v2026.9.20", "commit": REVISION}),
                 (TAG, {"release": TAG, "commit": "b" * 40}), (TAG, []), (TAG, None),
                 (None, {"release": TAG, "commit": REVISION}),
                 (None, {"commit": "b" * 40, "release": None}))
        for number, (release, identity) in enumerate(cases):
            target = self.dir / str(number)
            with self.subTest(release=release, identity=identity), \
                 patch.object(publish.subprocess, "run", side_effect=fake_save(identity=identity)) as run:
                with self.assertRaises(ValueError):
                    publish.write_layout(release, REVISION, "local", "amd64", target)
                self.assertEqual([call.args[0][:2] for call in run.call_args_list],
                                 [["docker", "image"], ["docker", "run"]])
                # The gate runs on the resolved image ID, not the mutable name.
                self.assertIn(run.side_effect(["docker", "image", "inspect"]).stdout.strip(),
                              run.call_args.args[0])
                self.assertFalse(target.exists())
        # The same stand-in with a matching identity does write a layout.
        with patch.object(publish.subprocess, "run", side_effect=fake_save(identity={"release": None, "commit": REVISION})):
            publish.write_layout(None, REVISION, "local", "amd64", self.dir / "unreleased")
        self.assertTrue((self.dir / "unreleased" / "manifest.json").exists())

    def test_image_probe_failure_prevents_the_layout(self):
        for failure in (subprocess.CalledProcessError(1, "docker"),
                        subprocess.TimeoutExpired("docker", 30)):
            def fail(command, **kwargs):
                if command[:3] == ["docker", "image", "inspect"]:
                    return subprocess.CompletedProcess([], 0, stdout="sha256:" + "f" * 64)
                raise failure
            with self.subTest(failure=failure), \
                 patch.object(publish.subprocess, "run", side_effect=fail):
                with self.assertRaises(type(failure)):
                    publish.write_layout(TAG, REVISION, "local", "amd64", self.dir / "layout")
        def unreadable(command, **kwargs):
            if command[:3] == ["docker", "image", "inspect"]:
                return subprocess.CompletedProcess([], 0, stdout="sha256:" + "f" * 64)
            return subprocess.CompletedProcess([], 0, stdout="not JSON")
        with patch.object(publish.subprocess, "run", side_effect=unreadable):
            with self.assertRaises(ValueError):
                publish.write_layout(TAG, REVISION, "local", "amd64", self.dir / "layout")
        self.assertFalse((self.dir / "layout").exists())

    def test_untagged_probe_image_must_report_its_commit_and_no_release(self):
        with patch.object(publish.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps({"release": None, "commit": REVISION}))):
            publish.verify_image_identity(None, REVISION, "local")

    def test_layout_is_the_saved_image_with_gzip_layers(self):
        for compressed, store in ((False, "classic"), (True, "classic"), (False, "containerd")):
            with self.subTest(compressed=compressed, store=store), \
                 patch.object(publish.subprocess, "run", side_effect=fake_save(compressed=compressed, store=store)):
                target = self.dir / (str(compressed) + store)
                digest = publish.write_layout(TAG, REVISION, "local", "amd64", target)
                layout = publish.read_layout(target, "amd64", REVISION)
                self.assertEqual(layout["digest"], digest)
                self.assertEqual(layout["platform"], {"architecture": "amd64", "os": "linux"})
                manifest = json.loads(layout["manifest"])
                self.assertEqual([layer["mediaType"] for layer in manifest["layers"]],
                                 [publish.LAYER_TYPE] * 2)
                self.assertEqual(sorted(path.name for path in (target / "blobs").iterdir()),
                                 sorted(blob["digest"][7:] for blob in layout["blobs"]))

    def test_layout_refuses_a_saved_image_that_is_not_the_gated_one(self):
        # Includes a save whose configuration is not the one the gated ID names.
        other = "sha256:" + hashlib.sha256(b"other").hexdigest()
        for args in ({"diff_ids": ["sha256:" + "c" * 64] * 2}, {"architecture": "arm64"},
                     {"revision": "b" * 40}, {"image_id": other}):
            with self.subTest(args=args), patch.object(publish.subprocess, "run", side_effect=fake_save(**args)):
                with self.assertRaises(ValueError):
                    publish.write_layout(TAG, REVISION, "local", "amd64", self.dir / str(len(str(args))))

    def test_read_layout_refuses_changed_blobs_platform_or_revision(self):
        with patch.object(publish.subprocess, "run", side_effect=fake_save()):
            publish.write_layout(TAG, REVISION, "local", "amd64", self.dir / "layout")
        with self.assertRaises(ValueError):
            publish.read_layout(self.dir / "layout", "arm64", REVISION)
        with self.assertRaises(ValueError):
            publish.read_layout(self.dir / "layout", "amd64", "b" * 40)
        # A layer with the same size and one changed byte.
        layer = json.loads((self.dir / "layout" / "manifest.json").read_bytes())["layers"][0]
        blob = self.dir / "layout" / "blobs" / layer["digest"][7:]
        data = bytearray(blob.read_bytes())
        data[-1] ^= 1
        blob.write_bytes(bytes(data))
        with self.assertRaises(ValueError):
            publish.read_layout(self.dir / "layout", "amd64", REVISION)

    def test_image_probe_reads_the_runtime_identity_without_booting_an_office(self):
        with patch.object(publish.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout=json.dumps({"release": TAG, "commit": REVISION}))) as run:
            publish.verify_image_identity(TAG, REVISION, "local")
        command = run.call_args.args[0]
        self.assertEqual(command[:8], ["docker", "run", "--rm", "--network=none",
                                      "--read-only", "--entrypoint", "bun", "local"])
        self.assertIn("./server/version.ts", command[-1])
        self.assertEqual(run.call_args.kwargs["timeout"], 30)

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

    def test_multi_arch_index_checks_every_image(self):
        amd64, arm64 = manifests(), manifests(architecture="arm64")
        raw = index(("amd64", amd64[0].headers["Docker-Content-Digest"]),
                    ("arm64", arm64[0].headers["Docker-Content-Digest"]))
        for require in (None, publish.ARCHES):
            with self.subTest(require=require), \
                 patch.object(publish, "request", side_effect=[response(raw), *manifests(),
                                                               *manifests(architecture="arm64")]):
                self.assertEqual(publish.existing_digest(TAG, REVISION, "fixture", require),
                                 "sha256:" + hashlib.sha256(raw).hexdigest())
        wrong = manifests("b" * 40, "arm64")
        raw = index(("amd64", amd64[0].headers["Docker-Content-Digest"]),
                    ("arm64", wrong[0].headers["Docker-Content-Digest"]))
        with patch.object(publish, "request", side_effect=[response(raw), *manifests(), *wrong]):
            with self.assertRaises(ValueError):
                publish.existing_digest(TAG, REVISION, "fixture")

    def test_index_with_an_unexpected_image_is_refused(self):
        # Every child is a valid image of its platform, so only the set is wrong.
        def child(architecture):
            replies = manifests(architecture=architecture)
            return (architecture, replies[0].headers["Docker-Content-Digest"]), replies
        for architectures in (("amd64", "amd64"), ("amd64", "ppc64le"), ("arm64",)):
            children = [child(architecture) for architecture in architectures]
            raw = index(*(entry for entry, _ in children))
            replies = [response(raw)] + [reply for _, pair in children for reply in pair]
            with self.subTest(architectures=architectures), \
                 patch.object(publish, "request", side_effect=replies):
                with self.assertRaises(ValueError):
                    publish.existing_digest(TAG, REVISION, "fixture")

    def test_a_tag_written_by_this_run_must_be_the_two_architecture_index(self):
        # Past single-arch forms stay valid for a retry, but not as the result of a new publish.
        single = manifests()
        with patch.object(publish, "request", side_effect=single):
            with self.assertRaises(ValueError):
                publish.existing_digest(TAG, REVISION, "fixture", publish.ARCHES)
        amd64 = manifests()
        raw = index(("amd64", amd64[0].headers["Docker-Content-Digest"]))
        with patch.object(publish, "request", side_effect=[response(raw), *amd64]):
            with self.assertRaises(ValueError):
                publish.existing_digest(TAG, REVISION, "fixture", publish.ARCHES)

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

    def layouts(self):
        directories = {}
        for architecture in publish.ARCHES:
            with patch.object(publish.subprocess, "run", side_effect=fake_save(architecture)):
                publish.write_layout(TAG, REVISION, "local", architecture, self.dir / architecture)
            directories[architecture] = self.dir / architecture
        return directories

    def push(self, tag, directories, registry=None, read_back=None):
        """publish_layouts with a recording skopeo. Returns (digest, command, layout).

        The layout skopeo gets is read while the command runs, before its
        temporary directory is removed.
        """
        registry = registry or REGISTRY
        seen = {}

        def run(command, **kwargs):
            assert command[:2] == ["skopeo", "copy"]
            source = pathlib.Path(command[-2].removeprefix("oci:"))
            blobs = source / "blobs" / "sha256"
            seen["command"] = command
            seen["index.json"] = json.loads((source / "index.json").read_text())
            seen["blobs"] = {path.name: path.read_bytes() for path in blobs.iterdir()}
            return subprocess.CompletedProcess(command, 0)

        def existing(reference, revision, authorization, require=None, api=None):
            if require is None:
                return None
            seen["read_back"] = (reference, require, api)
            return read_back or seen["index.json"]["manifests"][0]["digest"]
        with patch.object(publish.subprocess, "run", side_effect=run), \
             patch.object(publish, "existing_digest", side_effect=existing):
            digest = publish.publish_layouts(registry, tag, REVISION, directories)
        return digest, seen

    def test_retry_keeps_original_digest_without_push(self):
        # Includes a tag published before multi-arch releases: kept as it is.
        with patch.object(publish, "existing_digest", return_value="sha256:original") as existing, \
             patch.object(publish.subprocess, "run", side_effect=AssertionError("registry write")):
            self.assertEqual(publish.publish_layouts(REGISTRY, TAG, REVISION, self.layouts()),
                             "sha256:original")
        existing.assert_called_once_with(TAG, REVISION, "fixture", api="api")

    def test_retry_of_a_past_single_arch_tag_is_neither_rewritten_nor_rechecked_for_arm64(self):
        directories = self.layouts()
        single = manifests()
        with patch.object(publish, "request", side_effect=single), \
             patch.object(publish.subprocess, "run", side_effect=AssertionError("registry write")):
            self.assertEqual(publish.publish_layouts(REGISTRY, TAG, REVISION, directories),
                             single[0].headers["Docker-Content-Digest"])

    def test_retry_of_a_multi_arch_tag_writes_nothing(self):
        directories = self.layouts()
        amd64, arm64 = manifests(), manifests(architecture="arm64")
        raw = index(("amd64", amd64[0].headers["Docker-Content-Digest"]),
                    ("arm64", arm64[0].headers["Docker-Content-Digest"]))
        with patch.object(publish, "request", side_effect=[response(raw), *amd64, *arm64]), \
             patch.object(publish.subprocess, "run", side_effect=AssertionError("registry write")):
            self.assertEqual(publish.publish_layouts(REGISTRY, TAG, REVISION, directories),
                             "sha256:" + hashlib.sha256(raw).hexdigest())

    def test_an_existing_tag_of_another_revision_writes_nothing(self):
        directories = self.layouts()
        for existing in (manifests("b" * 40), manifests("b" * 40, "arm64")):
            with self.subTest(existing=existing), patch.object(publish, "request", side_effect=existing), \
                 patch.object(publish.subprocess, "run", side_effect=AssertionError("registry write")):
                with self.assertRaises(ValueError):
                    publish.publish_layouts(REGISTRY, TAG, REVISION, directories)

    def test_new_tag_pushes_the_checked_images_and_their_index_unchanged(self):
        directories = self.layouts()
        digest, seen = self.push(TAG, directories)
        command = seen["command"]
        self.assertEqual(command[:6], ["skopeo", "copy", "--all", "--preserve-digests", "--retry-times", "3"])
        self.assertIn("--dest-authfile", command)
        self.assertNotIn("--dest-tls-verify=false", command)
        self.assertEqual(command[-1], "docker://registry.test/image:" + TAG)
        # The layout's one entry is the index, and the index is exactly the checked images.
        [entry] = seen["index.json"]["manifests"]
        self.assertEqual(entry["mediaType"], publish.INDEX_TYPE)
        raw = seen["blobs"][entry["digest"][7:]]
        self.assertEqual(entry["digest"], "sha256:" + hashlib.sha256(raw).hexdigest())
        layouts = [publish.read_layout(directories[arch], arch, REVISION) for arch in publish.ARCHES]
        self.assertEqual([(child["platform"]["architecture"], child["digest"])
                          for child in json.loads(raw)["manifests"]],
                         [(arch, layout["digest"]) for arch, layout in zip(publish.ARCHES, layouts)])
        for layout in layouts:
            self.assertEqual(seen["blobs"][layout["digest"][7:]], layout["manifest"])
            for blob in layout["blobs"]:
                self.assertEqual("sha256:" + hashlib.sha256(seen["blobs"][blob["digest"][7:]]).hexdigest(),
                                 blob["digest"])
        # The tag is read back and must be that index of exactly both architectures.
        self.assertEqual(seen["read_back"], (TAG, publish.ARCHES, "api"))
        self.assertEqual(digest, entry["digest"])

    def test_a_push_without_a_tag_goes_by_digest(self):
        directories = self.layouts()
        with patch.object(publish, "request", side_effect=AssertionError("no tag lookup")):
            digest, seen = self.push(None, directories)
        self.assertEqual(seen["command"][-1], "docker://registry.test/image@" + digest)
        self.assertEqual(seen["read_back"], (digest, publish.ARCHES, "api"))

    def test_a_different_published_index_fails(self):
        with self.assertRaises(ValueError):
            self.push(TAG, self.layouts(), read_back="sha256:" + "0" * 64)

    def test_collision_never_pushes(self):
        with patch.object(publish, "existing_digest", side_effect=ValueError), \
             patch.object(publish.subprocess, "run", side_effect=AssertionError("registry write")):
            with self.assertRaises(ValueError):
                publish.publish_layouts(REGISTRY, TAG, REVISION, self.layouts())

    @patch.object(publish.subprocess, "run", side_effect=AssertionError("registry write"))
    @patch.object(publish, "existing_digest")
    def test_publication_needs_both_checked_layouts_before_registry_access(self, existing, run):
        directories = self.layouts()
        for bad in ({"amd64": directories["amd64"]},
                    {"amd64": directories["arm64"], "arm64": directories["amd64"]}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                publish.publish_layouts(REGISTRY, TAG, REVISION, bad)
        with self.assertRaises(ValueError):
            publish.publish_layouts(REGISTRY, TAG, "b" * 40, directories)
        # A corrupt arm64 artifact stops publication before the amd64 image is pushed.
        layer = json.loads((directories["arm64"] / "manifest.json").read_bytes())["layers"][0]
        blob = directories["arm64"] / "blobs" / layer["digest"][7:]
        blob.write_bytes(blob.read_bytes()[:-1])
        with self.assertRaises(ValueError):
            publish.publish_layouts(REGISTRY, TAG, REVISION, directories)
        existing.assert_not_called()
        run.assert_not_called()

    def test_only_a_local_registry_is_reached_over_plain_http_without_credentials(self):
        registry = publish.local_registry("127.0.0.1:15000/isomux-fixture")
        self.assertEqual(registry, publish.Registry("127.0.0.1:15000/isomux-fixture",
                                                    "http://127.0.0.1:15000/v2/isomux-fixture",
                                                    None, None, False))
        _, seen = self.push(TAG, self.layouts(), registry)
        self.assertIn("--dest-tls-verify=false", seen["command"])
        self.assertNotIn("--dest-authfile", seen["command"])
        for image in ("ghcr.io/nmamano/isomux", "localhost.example.com/isomux", "localhost:5000"):
            with self.subTest(image=image), self.assertRaises(ValueError):
                publish.local_registry(image)

    def test_ghcr_login_keeps_the_credential_out_of_arguments(self):
        for tag in (TAG, None):
            logins, published = [], []

            def run(command, **kwargs):
                logins.append((command, kwargs))
                return subprocess.CompletedProcess(command, 0)

            def publish_layouts(registry, tag, revision, directories):
                published.append((registry, tag, pathlib.Path(registry.authfile).parent.exists()))
                return "sha256:" + "c" * 64
            with self.subTest(tag=tag), patch.object(publish.subprocess, "run", side_effect=run), \
                 patch.object(publish, "registry_token", return_value="Bearer fixture"), \
                 patch.object(publish, "publish_layouts", side_effect=publish_layouts):
                self.assertEqual(publish.to_ghcr(tag, REVISION, {}, "actor", "secret-credential"),
                                 publish.IMAGE + "@sha256:" + "c" * 64)
                [(login, options)] = logins
                self.assertEqual(login[:2], ["skopeo", "login"])
                self.assertEqual(login[-1], "ghcr.io")
                self.assertNotIn("secret-credential", login)
                self.assertEqual(options["input"], "secret-credential")
                [(registry, pushed_tag, present)] = published
                self.assertEqual(registry.authfile, login[login.index("--authfile") + 1])
                self.assertEqual((registry.image, registry.api, registry.authorization, registry.tls_verify),
                                 (publish.IMAGE, publish.API, "Bearer fixture", True))
                self.assertEqual(pushed_tag, tag)
                # The credential file exists only while skopeo pushes.
                self.assertTrue(present)
                self.assertFalse(pathlib.Path(registry.authfile).parent.exists())

    def test_only_a_release_publishes_a_tag(self):
        with self.assertRaises(ValueError):
            publish.publish(None, REVISION, {}, "actor", "secret")

    @patch.object(publish, "registry_token")
    def test_invalid_identity_never_authenticates(self, token):
        for tag, revision in (("latest", REVISION), (TAG, "main"), ("v2026.9.21;echo bad", REVISION),
                              (None, REVISION)):
            with self.assertRaises(ValueError):
                publish.publish(tag, revision, {}, "actor", "secret")
        token.assert_not_called()


if __name__ == "__main__":
    unittest.main()
