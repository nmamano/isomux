"""Publish only a new CalVer tag, as one index of a linux/amd64 and a linux/arm64 image.

`layout ARCH DIR` runs in each architecture's build job, which has no registry
credentials: it checks the built image's version identity and writes that
exact image as a push-ready layout. `publish AMD64_DIR ARM64_DIR` runs in the
one job that can write the registry, after both build jobs passed: it pushes
both images by digest and then one index under the tag. The workflow
serializes writers per tag.
"""
import argparse
import base64
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


def send(method, url, authorization, data=None, headers=None):
    """One registry write or HEAD. urllib follows no redirect for writes."""
    headers = dict(headers or {})
    if authorization:
        headers["Authorization"] = authorization
    return urllib.request.build_opener(RegistryRedirect()).open(
        urllib.request.Request(url, data=data, headers=headers, method=method), timeout=60)


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
    """The tag's digest if it already holds this revision, None if absent.

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


def location(api, response):
    """The next upload URL. It carries the registry credential, so it must stay
    on the registry's own scheme and host."""
    target = response.headers.get("Location")
    if not target:
        raise ValueError("Registry upload has no location")
    resolved = urllib.parse.urljoin(api, target)
    if urllib.parse.urlsplit(resolved).scheme != urllib.parse.urlsplit(api).scheme:
        raise ValueError("Registry upload location changes scheme")
    if urllib.parse.urlsplit(resolved).netloc != urllib.parse.urlsplit(api).netloc:
        raise ValueError("Registry upload location changes host")
    return resolved


def push_blob(api, authorization, directory, blob):
    try:
        send("HEAD", f"{api}/blobs/{blob['digest']}", authorization).close()
        return
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
    with send("POST", f"{api}/blobs/uploads/", authorization, b"") as response:
        upload = location(api, response)
    path = directory / "blobs" / blob["digest"].split(":")[1]
    with open(path, "rb") as stream, send("PATCH", upload, authorization, stream, {
            "Content-Type": "application/octet-stream",
            "Content-Length": str(blob["size"])}) as response:
        upload = location(api, response)
    separator = "&" if "?" in upload else "?"
    with send("PUT", upload + separator + "digest=" + urllib.parse.quote(blob["digest"]),
              authorization, b"") as response:
        if response.headers.get("Docker-Content-Digest") not in (None, blob["digest"]):
            raise ValueError("Registry stored a different blob")


def put_manifest(api, authorization, reference, raw, media_type):
    with send("PUT", f"{api}/manifests/{reference}", authorization, raw,
              {"Content-Type": media_type}) as response:
        stored = response.headers.get("Docker-Content-Digest")
    if stored != "sha256:" + hashlib.sha256(raw).hexdigest():
        raise ValueError("Registry stored a different manifest")


def index_manifest(layouts):
    return json.dumps({
        "schemaVersion": 2,
        "mediaType": INDEX_TYPE,
        "manifests": [{"mediaType": MANIFEST_TYPE, "digest": layout["digest"],
                       "size": len(layout["manifest"]), "platform": layout["platform"]}
                      for layout in layouts],
    }, separators=(",", ":")).encode()


def publish_layouts(api, authorization, tag, revision, directories):
    """Push both images by digest, then the index under the tag. Never rewrites a tag."""
    if tag is None:
        raise ValueError("Publication requires a release tag")
    check_identity(tag, revision)
    if set(directories) != set(ARCHES):
        raise ValueError("Publication requires exactly the linux/amd64 and linux/arm64 images")
    layouts = [read_layout(directories[architecture], architecture, revision) for architecture in ARCHES]
    digest = existing_digest(tag, revision, authorization, api=api)
    if digest is not None:
        return digest
    for layout in layouts:
        for blob in layout["blobs"]:
            push_blob(api, authorization, layout["directory"], blob)
        put_manifest(api, authorization, layout["digest"], layout["manifest"], MANIFEST_TYPE)
    index = index_manifest(layouts)
    put_manifest(api, authorization, tag, index, INDEX_TYPE)
    digest = existing_digest(tag, revision, authorization, require=ARCHES, api=api)
    if digest != "sha256:" + hashlib.sha256(index).hexdigest():
        raise ValueError("Published index is missing or different")
    return digest


def local_api(image):
    """The registry API of a local test image reference such as localhost:5000/nmamano/isomux."""
    host, _, name = image.partition("/")
    if host.split(":")[0] not in ("localhost", "127.0.0.1") or not name:
        raise ValueError("Rehearsal publishes only to a local registry")
    return f"http://{host}/v2/{name}"


def publish(tag, revision, directories, actor, credential):
    if tag is None:
        raise ValueError("Publication requires a release tag")
    check_identity(tag, revision)
    authorization = registry_token(actor, credential)
    return f"{IMAGE}@{publish_layouts(API, authorization, tag, revision, directories)}"


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
    rehearse = commands.add_parser("rehearse", help="publish both layouts to a local test registry")
    rehearse.add_argument("image", help="a local registry repository, such as localhost:5000/nmamano/isomux")
    rehearse.add_argument("tag")
    rehearse.add_argument("directories", nargs=2, metavar=("AMD64_DIR", "ARM64_DIR"))
    args = parser.parse_args()
    revision = os.environ["REVISION"]
    if args.command == "layout":
        digest = write_layout(args.release, revision, os.environ["LOCAL_IMAGE"],
                              args.architecture, args.directory)
        print(f"linux/{args.architecture} manifest {digest}")
        return
    directories = dict(zip(ARCHES, args.directories))
    if args.command == "rehearse":
        print(publish_layouts(local_api(args.image), None, args.tag, revision, directories))
        return
    reference = publish(os.environ["RELEASE_TAG"], revision, directories,
                        os.environ["GITHUB_ACTOR"], os.environ["GITHUB_TOKEN"])
    summary = f"Release: {os.environ['RELEASE_TAG']}\nSource: {revision}\nImage: `{reference}`\n"
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary)


if __name__ == "__main__":
    main()
