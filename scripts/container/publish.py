"""Publish only a new CalVer tag. The workflow serializes writers per tag."""
import base64
import hashlib
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
import urllib.parse

IMAGE = "ghcr.io/nmamano/isomux"
API = "https://ghcr.io/v2/nmamano/isomux"
MANIFEST = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))


class RegistryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).scheme != "https":
            raise ValueError("Registry redirect requires HTTPS")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def request(url, authorization, accept="application/json"):
    return urllib.request.build_opener(RegistryRedirect()).open(urllib.request.Request(url, headers={
        "Authorization": authorization, "Accept": accept,
    }), timeout=30)


def registry_token(actor, credential):
    basic = base64.b64encode(f"{actor}:{credential}".encode()).decode()
    with request("https://ghcr.io/token?service=ghcr.io&scope=repository:nmamano/isomux:pull,push",
                 "Basic " + basic) as response:
        return "Bearer " + json.load(response)["token"]


def existing_digest(tag, revision, authorization):
    try:
        response = request(f"{API}/manifests/{tag}", authorization, MANIFEST)
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
    # BuildKit can wrap the amd64 image with a provenance attestation. Keep
    # the top-level digest as the deployment identity, but inspect its image.
    if "manifests" in manifest:
        images = [entry for entry in manifest["manifests"]
                  if entry.get("platform", {}).get("os") == "linux"
                  and entry.get("platform", {}).get("architecture") == "amd64"]
        if len(images) != 1:
            raise ValueError("Release index must contain one Linux amd64 image")
        child_digest = images[0]["digest"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", child_digest):
            raise ValueError("Invalid child manifest digest")
        with request(f"{API}/manifests/{child_digest}", authorization, MANIFEST) as response:
            raw = response.read()
            if "sha256:" + hashlib.sha256(raw).hexdigest() != child_digest:
                raise ValueError("Registry child manifest digest mismatch")
            manifest = json.loads(raw)
    config_digest = manifest["config"]["digest"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", config_digest):
        raise ValueError("Invalid image configuration digest")
    with request(f"{API}/blobs/{config_digest}", authorization) as response:
        raw = response.read()
        if "sha256:" + hashlib.sha256(raw).hexdigest() != config_digest:
            raise ValueError("Registry configuration digest mismatch")
        config = json.loads(raw)
    if (config.get("os"), config.get("architecture")) != ("linux", "amd64"):
        raise ValueError("Existing release image has a different platform")
    if config.get("config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != revision:
        raise ValueError("Existing release tag has a different source revision; refusing overwrite")
    return digest


def publish(tag, revision, local_image, actor, credential):
    if not re.fullmatch(r"v[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}(\.[0-9]+)?", tag):
        raise ValueError("Invalid release tag")
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid source revision")
    authorization = registry_token(actor, credential)
    digest = existing_digest(tag, revision, authorization)
    if digest is None:
        subprocess.run(["docker", "login", "ghcr.io", "-u", actor, "--password-stdin"],
                       input=credential, text=True, check=True, stdout=subprocess.DEVNULL)
        try:
            subprocess.run(["docker", "tag", local_image, f"{IMAGE}:{tag}"], check=True)
            subprocess.run(["docker", "push", f"{IMAGE}:{tag}"], check=True)
        finally:
            subprocess.run(["docker", "logout", "ghcr.io"], check=True, stdout=subprocess.DEVNULL)
        digest = existing_digest(tag, revision, authorization)
        if digest is None:
            raise ValueError("Published manifest is missing")
    return f"{IMAGE}@{digest}"


if __name__ == "__main__":
    reference = publish(os.environ["RELEASE_TAG"], os.environ["REVISION"],
                        os.environ["LOCAL_IMAGE"], os.environ["GITHUB_ACTOR"],
                        os.environ["GITHUB_TOKEN"])
    summary = f"Release: {os.environ['RELEASE_TAG']}\nSource: {os.environ['REVISION']}\nImage: `{reference}`\n"
    print(summary)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(summary)
