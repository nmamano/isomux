"""Publish only a new CalVer tag, as one index of a linux/amd64 and a linux/arm64 image.

`layout ARCH DIR` runs in each architecture's build job, which has no registry
credentials: it checks the built image's version identity and writes that
exact image as a push-ready layout. `publish AMD64_DIR ARM64_DIR` runs in the
one job that writes release tags, after both build jobs passed: skopeo pushes
both images and their index, digests unchanged, under the tag, and the index
is read back. `rehearse` does the same into ghcr.io by digest only, with no
tag. The workflow serializes writers per tag.
"""
import argparse
import base64
import collections
import gzip
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
import urllib.parse

IMAGE = "ghcr.io/nmamano/isomux"
API = "https://ghcr.io/v2/nmamano/isomux"
TAG = re.compile(r"v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?")
ARCHES = ("amd64", "arm64")
INDEX_TYPE = "application/vnd.oci.image.index.v1+json"
MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json"
CONFIG_TYPE = "application/vnd.oci.image.config.v1+json"
LAYER_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip"
MANIFEST = ", ".join((
    INDEX_TYPE,
    MANIFEST_TYPE,
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")


class RegistryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise ValueError("Registry redirect requires HTTPS")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def request(url, authorization, accept="application/json"):
    headers = {"Accept": accept}
    if authorization:
        headers["Authorization"] = authorization
    return urllib.request.build_opener(RegistryRedirect()).open(
        urllib.request.Request(url, headers=headers), timeout=30)


def registry_token(actor, credential):
    basic = base64.b64encode(f"{actor}:{credential}".encode()).decode()
    with request("https://ghcr.io/token?service=ghcr.io&scope=repository:nmamano/isomux:pull,push",
                 "Basic " + basic) as response:
        return "Bearer " + json.load(response)["token"]


def fetch(url, authorization, digest, accept):
    with request(url, authorization, accept) as response:
        raw = response.read()
    if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Registry content digest mismatch")
    return raw


def check_config(api, authorization, manifest, architecture, revision):
    config_digest = manifest["config"]["digest"]
    if not DIGEST.fullmatch(config_digest):
        raise ValueError("Invalid image configuration digest")
    config = json.loads(fetch(f"{api}/blobs/{config_digest}", authorization, config_digest,
                              "application/json"))
    if (config.get("os"), config.get("architecture")) != ("linux", architecture):
        raise ValueError("Existing release image has a different platform")
    if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != revision:
        raise ValueError("Existing release tag has a different source revision; refusing overwrite")


def existing_digest(tag, revision, authorization, require=None, api=API):
    """The digest of a tag (or digest reference) if it holds this revision, None if absent.

    Tags published before multi-arch releases hold one amd64 image, or an
    index of one amd64 image and attestations. A retry accepts them as they
    are and never rewrites them. `require` is the exact architecture set that
    a tag written by this run must have.
    """
    try:
        response = request(f"{api}/manifests/{tag}", authorization, MANIFEST)
    except urllib.error.HTTPError as error:
        # Auth, network, rate-limit, and server errors must never mean absent.
        if error.code == 404:
            return None
        raise
    with response:
        raw = response.read()
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        if response.headers.get("Docker-Content-Digest") != digest:
            raise ValueError("Registry manifest digest mismatch")
        manifest = json.loads(raw)
    if "manifests" not in manifest:
        if require:
            raise ValueError("Release tag is not a multi-architecture index")
        check_config(api, authorization, manifest, "amd64", revision)
        return digest
    # Keep the top-level digest as the deployment identity, but inspect its
    # images. BuildKit attestations are listed with platform unknown/unknown.
    children = {}
    for entry in manifest["manifests"]:
        platform = entry.get("platform", {})
        if platform.get("os") != "linux":
            continue
        architecture = platform.get("architecture")
        if architecture not in ARCHES or architecture in children:
            raise ValueError("Release index has an unexpected Linux image")
        children[architecture] = entry["digest"]
    if "amd64" not in children:
        raise ValueError("Release index must contain one Linux amd64 image")
    if require and set(children) != set(require):
        raise ValueError("Release index must contain exactly the published architectures")
    for architecture, child in children.items():
        if not DIGEST.fullmatch(child):
            raise ValueError("Invalid child manifest digest")
        manifest = json.loads(fetch(f"{api}/manifests/{child}", authorization, child, MANIFEST))
        check_config(api, authorization, manifest, architecture, revision)
    return digest


def verify_image_identity(release, revision, local_image):
    """`release` is the tag the image must report, or None for an untagged probe."""
    result = subprocess.run(
        ["docker", "run", "--rm", "--network=none", "--read-only",
         "--entrypoint", "bun", local_image, "-e",
         'import {getVersionInfo} from "./server/version.ts"; console.log(JSON.stringify(getVersionInfo()))'],
        check=True, capture_output=True, text=True, timeout=30,
    )
    identity = json.loads(result.stdout)
    if not isinstance(identity, dict) or identity.get("release") != release or identity.get("commit") != revision:
        raise ValueError("Built image version does not match the release tag and source revision")


def check_identity(tag, revision):
    if tag is not None and not TAG.fullmatch(tag):
        raise ValueError("Invalid release tag")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid source revision")


def check_platform(config, architecture, revision):
    if (config.get("os"), config.get("architecture")) != ("linux", architecture):
        raise ValueError("Built image has a different platform")
    if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != revision:
        raise ValueError("Built image has a different source revision")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        while chunk := stream.read(1 << 20):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def write_layer(source, blobs):
    """Store one saved layer gzip-compressed. Returns its descriptor and diff ID."""
    head = source.read(2)
    source.seek(0)
    diff = hashlib.sha256()
    target = blobs / "layer.tmp"
    with open(target, "wb") as output:
        if head == b"\x1f\x8b":
            shutil.copyfileobj(source, output)
            source.seek(0)
            with gzip.GzipFile(fileobj=source) as plain:
                while chunk := plain.read(1 << 20):
                    diff.update(chunk)
        else:
            with gzip.GzipFile(filename="", fileobj=output, mode="wb", mtime=0) as packed:
                while chunk := source.read(1 << 20):
                    diff.update(chunk)
                    packed.write(chunk)
    digest = sha256_file(target)
    stored = blobs / digest.split(":")[1]
    target.rename(stored)
    return ({"mediaType": LAYER_TYPE, "digest": digest, "size": stored.stat().st_size},
            "sha256:" + diff.hexdigest())


def gated_config(archive, digest, architecture):
    """The config digest that an image ID names inside a saved image.

    In Docker's classic store the ID is the config digest. In the containerd
    store it is a manifest, or an index of this platform's manifest and
    attestations.
    """
    try:
        raw = archive.extractfile("blobs/sha256/" + digest.split(":")[1]).read()
    except KeyError:
        raise ValueError("Saved image does not contain the gated image") from None
    if "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("Saved image blob does not match its digest")
    document = json.loads(raw)
    if "manifests" in document:
        entries = [entry for entry in document["manifests"]
                   if entry.get("platform", {}).get("os") == "linux"
                   and entry["platform"].get("architecture") == architecture]
        if len(entries) != 1:
            raise ValueError("Saved image index must have one image for this platform")
        return gated_config(archive, entries[0]["digest"], architecture)
    if "layers" in document:
        return document["config"]["digest"]
    return digest


def write_layout(release, revision, local_image, architecture, directory):
    """Write the gated local image as its config, gzip layers and one OCI manifest.

    The identity gate and the save both name the image by its ID, and the saved
    configuration must be the one that ID names, so the layout is the gated image.
    """
    check_identity(release, revision)
    if architecture not in ARCHES:
        raise ValueError("Unsupported architecture")
    image_id = subprocess.run(["docker", "image", "inspect", "--format", "{{.Id}}", local_image],
                              check=True, capture_output=True, text=True, timeout=30).stdout.strip()
    if not DIGEST.fullmatch(image_id):
        raise ValueError("Invalid local image ID")
    verify_image_identity(release, revision, image_id)
    directory = pathlib.Path(directory)
    blobs = directory / "blobs"
    blobs.mkdir(parents=True)
    with tempfile.TemporaryDirectory(dir=directory) as scratch:
        saved = pathlib.Path(scratch) / "image.tar"
        subprocess.run(["docker", "save", "-o", str(saved), image_id], check=True)
        with tarfile.open(saved) as archive:
            entries = json.load(archive.extractfile("manifest.json"))
            if len(entries) != 1:
                raise ValueError("Saved image must contain one image")
            config_raw = archive.extractfile(entries[0]["Config"]).read()
            config_digest = "sha256:" + hashlib.sha256(config_raw).hexdigest()
            if gated_config(archive, image_id, architecture) != config_digest:
                raise ValueError("Saved image is not the gated image")
            layers, diffs = [], []
            for name in entries[0]["Layers"]:
                layer, diff = write_layer(archive.extractfile(name), blobs)
                layers.append(layer)
                diffs.append(diff)
    config = json.loads(config_raw)
    if diffs != config["rootfs"]["diff_ids"]:
        raise ValueError("Saved layers do not match the image configuration")
    check_platform(config, architecture, revision)
    (blobs / config_digest.split(":")[1]).write_bytes(config_raw)
    manifest = json.dumps({
        "schemaVersion": 2,
        "mediaType": MANIFEST_TYPE,
        "config": {"mediaType": CONFIG_TYPE, "digest": config_digest, "size": len(config_raw)},
        "layers": layers,
    }, separators=(",", ":")).encode()
    (directory / "manifest.json").write_bytes(manifest)
    return "sha256:" + hashlib.sha256(manifest).hexdigest()


def read_layout(directory, architecture, revision):
    """Recheck a layout from another job: every blob hash, the platform and the revision."""
    directory = pathlib.Path(directory)
    raw = (directory / "manifest.json").read_bytes()
    manifest = json.loads(raw)
    if manifest.get("mediaType") != MANIFEST_TYPE:
        raise ValueError("Layout manifest has an unexpected type")
    blobs = [manifest["config"], *manifest["layers"]]
    for blob in blobs:
        if not DIGEST.fullmatch(blob["digest"]):
            raise ValueError("Invalid layout digest")
        path = directory / "blobs" / blob["digest"].split(":")[1]
        if sha256_file(path) != blob["digest"] or path.stat().st_size != blob["size"]:
            raise ValueError("Layout blob does not match its manifest")
    config = json.loads((directory / "blobs" / manifest["config"]["digest"].split(":")[1]).read_bytes())
    check_platform(config, architecture, revision)
    platform = {"architecture": architecture, "os": "linux"}
    if config.get("variant"):
        platform["variant"] = config["variant"]
    return {"directory": directory, "manifest": raw, "blobs": blobs, "platform": platform,
            "digest": "sha256:" + hashlib.sha256(raw).hexdigest()}


def index_manifest(layouts):
    return json.dumps({
        "schemaVersion": 2,
        "mediaType": INDEX_TYPE,
        "manifests": [{"mediaType": MANIFEST_TYPE, "digest": layout["digest"],
                       "size": len(layout["manifest"]), "platform": layout["platform"]}
                      for layout in layouts],
    }, separators=(",", ":")).encode()


def oci_layout(layouts, directory):
    """One OCI image layout of both checked images and their index, for skopeo."""
    blobs = directory / "blobs" / "sha256"
    blobs.mkdir(parents=True)
    for layout in layouts:
        for blob in layout["blobs"]:
            source = layout["directory"] / "blobs" / blob["digest"].split(":")[1]
            try:
                os.link(source, blobs / source.name)
            except OSError:
                shutil.copyfile(source, blobs / source.name)
        (blobs / layout["digest"].split(":")[1]).write_bytes(layout["manifest"])
    index = index_manifest(layouts)
    digest = "sha256:" + hashlib.sha256(index).hexdigest()
    (blobs / digest.split(":")[1]).write_bytes(index)
    (directory / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}')
    (directory / "index.json").write_text(json.dumps({"schemaVersion": 2, "manifests": [
        {"mediaType": INDEX_TYPE, "digest": digest, "size": len(index)}]}))
    return digest


# Where to push, how to read back, and skopeo's credential file.
Registry = collections.namedtuple("Registry", "image api authorization authfile tls_verify")


def publish_layouts(registry, tag, revision, directories):
    """Push both images and their index with skopeo, unchanged: under the tag,
    or by digest only when tag is None. Never rewrites a tag."""
    check_identity(tag, revision)
    if set(directories) != set(ARCHES):
        raise ValueError("Publication requires exactly the linux/amd64 and linux/arm64 images")
    layouts = [read_layout(directories[architecture], architecture, revision) for architecture in ARCHES]
    if tag is not None:
        digest = existing_digest(tag, revision, registry.authorization, api=registry.api)
        if digest is not None:
            return digest
    # Beside the layouts, so the blobs can be hard links.
    with tempfile.TemporaryDirectory(dir=pathlib.Path(directories["amd64"]).parent) as scratch:
        expected = oci_layout(layouts, pathlib.Path(scratch) / "oci")
        command = ["skopeo", "copy", "--all", "--preserve-digests", "--retry-times", "3"]
        if registry.authfile:
            command += ["--dest-authfile", registry.authfile]
        if not registry.tls_verify:
            command += ["--dest-tls-verify=false"]
        destination = f"{registry.image}:{tag}" if tag is not None else f"{registry.image}@{expected}"
        subprocess.run([*command, "oci:" + scratch + "/oci", "docker://" + destination],
                       check=True, timeout=3600)
    digest = existing_digest(tag or expected, revision, registry.authorization, require=ARCHES,
                             api=registry.api)
    if digest != expected:
        raise ValueError("Published index is missing or different")
    return digest


def local_registry(image):
    """A local test registry, such as localhost:5000/nmamano/isomux, over plain HTTP."""
    host, _, name = image.partition("/")
    if host.split(":")[0] not in ("localhost", "127.0.0.1") or not name:
        raise ValueError("Only a local registry is reached without credentials")
    return Registry(image, f"http://{host}/v2/{name}", None, None, False)


def to_ghcr(tag, revision, directories, actor, credential):
    """Publish to ghcr.io; with tag None, by digest only, so no tag changes."""
    check_identity(tag, revision)
    authorization = registry_token(actor, credential)
    with tempfile.TemporaryDirectory() as private:
        authfile = str(pathlib.Path(private) / "auth.json")
        subprocess.run(["skopeo", "login", "--authfile", authfile, "--username", actor,
                        "--password-stdin", "ghcr.io"],
                       input=credential, text=True, check=True, stdout=subprocess.DEVNULL, timeout=60)
        registry = Registry(IMAGE, API, authorization, authfile, True)
        return f"{IMAGE}@{publish_layouts(registry, tag, revision, directories)}"


def publish(tag, revision, directories, actor, credential):
    if tag is None:
        raise ValueError("Publication requires a release tag")
    return to_ghcr(tag, revision, directories, actor, credential)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    layout = commands.add_parser("layout", help="check the built image and write its layout")
    layout.add_argument("architecture", choices=ARCHES)
    layout.add_argument("directory")
    release = layout.add_mutually_exclusive_group(required=True)
    release.add_argument("--release", help="the tag the image must report")
    release.add_argument("--unreleased", action="store_true", help="the image must report no release")
    commands.add_parser("publish", help="publish both layouts to ghcr.io").add_argument(
        "directories", nargs=2, metavar=("AMD64_DIR", "ARM64_DIR"))
    commands.add_parser("rehearse", help="publish both layouts to ghcr.io by digest, with no tag").add_argument(
        "directories", nargs=2, metavar=("AMD64_DIR", "ARM64_DIR"))
    args = parser.parse_args()
    revision = os.environ["REVISION"]
    if args.command == "layout":
        digest = write_layout(args.release, revision, os.environ["LOCAL_IMAGE"],
                              args.architecture, args.directory)
        print(f"linux/{args.architecture} manifest {digest}")
        return
    directories = dict(zip(ARCHES, args.directories))
    if args.command == "rehearse":
        print(to_ghcr(None, revision, directories, os.environ["GITHUB_ACTOR"], os.environ["GITHUB_TOKEN"]))
        return
    reference = publish(os.environ["RELEASE_TAG"], revision, directories,
                        os.environ["GITHUB_ACTOR"], os.environ["GITHUB_TOKEN"])
    summary = f"Release: {os.environ['RELEASE_TAG']}\nSource: {revision}\nImage: `{reference}`\n"
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary)


if __name__ == "__main__":
    main()
