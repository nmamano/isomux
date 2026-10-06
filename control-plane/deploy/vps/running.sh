# What runs, read from the engine. Sourced by deploy.sh and auto-deploy.sh.
#
#   release_healthy <commit> <web port> <compose command...>
#
# Succeeds when the provisioner and the storefront both run an image labelled
# with <commit>, the provisioner's health is ok with database_identity true at
# <commit>, and the storefront home page answers 200. On failure it prints one
# line that says what did not hold, and no value from an env file.
release_healthy() {
  local commit=$1 web_port=$2
  shift 2
  local service container image revision health ok identity running code
  for service in provisioner web; do
    container=$("$@" ps -q "$service" 2>/dev/null) || container=""
    [[ -n $container ]] || {
      echo "$service is not running"
      return 1
    }
    image=$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null) || image=""
    revision=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null) || revision=""
    [[ $revision == "$commit" ]] || {
      echo "$service does not run revision $commit"
      return 1
    }
  done
  health=$("$@" exec -T provisioner bun -e '
const r = await fetch("http://127.0.0.1:4311/internal/health", {
  headers: { authorization: "Bearer " + process.env.CONTROL_PLANE_MINT_TOKEN },
});
const h = await r.json();
console.log([h.ok, h.database_identity, h.release_source?.commit ?? "unknown"].join(" "));
' 2>/dev/null) || {
    echo "the provisioner health read failed"
    return 1
  }
  read -r ok identity running <<<"$health"
  [[ $ok == true && $identity == true && $running == "$commit" ]] || {
    echo "provisioner health is not ok with database_identity true at $commit"
    return 1
  }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$web_port/") || code=none
  [[ $code == 200 ]] || {
    echo "the storefront home page answered $code"
    return 1
  }
}
