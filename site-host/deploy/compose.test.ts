// The isolation of isomux.com on the shared VPS (compose.yaml): no container runs
// as root, writes its image or gains privileges, none publishes a port, the site
// has no route out except the allowlist proxy, and the proxy allows only the two
// hosts the chat calls. Caddy, the tmpfiles entry and compose agree on the socket.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Service = {
  image?: string;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
  privileged?: boolean;
  ports?: unknown;
  network_mode?: string;
  networks?: string[] | Record<string, unknown>;
  environment?: Record<string, string> | string[];
  command?: string[] | string;
  volumes?: ({ type?: string; source?: string; target?: string } | string)[];
};
type Compose = {
  services: Record<string, Service>;
  networks?: Record<string, { internal?: boolean } | null>;
};

const dir = import.meta.dir;
const compose = Bun.YAML.parse(
  readFileSync(join(dir, "compose.yaml"), "utf8"),
) as Compose;
const services = compose.services ?? {};

function networksOf(service: Service): string[] {
  const networks = service.networks;
  if (!networks) return ["default"];
  return Array.isArray(networks) ? networks : Object.keys(networks);
}

function env(service: Service): Record<string, string> {
  const environment = service.environment ?? {};
  if (!Array.isArray(environment)) return environment;
  return Object.fromEntries(
    environment.map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
  );
}

const internal = (name: string) => compose.networks?.[name]?.internal === true;

describe("compose.yaml", () => {
  it("runs the site and the egress proxy from the pinned image", () => {
    expect(Object.keys(services).sort()).toEqual(["egress", "site"]);
    for (const service of Object.values(services))
      expect(service.image).toMatch(/^\$\{ISOMUX_SITE_IMAGE(:\?[^}]*)?\}$/);
  });

  it("hardens every service", () => {
    expect(Object.keys(services).length).toBeGreaterThan(0);
    for (const [name, service] of Object.entries(services)) {
      const where = { name };
      expect({ ...where, read_only: service.read_only }).toEqual({
        ...where,
        read_only: true,
      });
      expect({ ...where, cap_drop: service.cap_drop }).toEqual({
        ...where,
        cap_drop: ["ALL"],
      });
      expect({ ...where, cap_add: service.cap_add }).toEqual({
        ...where,
        cap_add: undefined,
      });
      expect(service.security_opt ?? []).toContain("no-new-privileges:true");
      expect(service.privileged).not.toBe(true);
      // The dedicated system user from release.env, never root.
      expect({ ...where, user: service.user }).toEqual({
        ...where,
        user: expect.stringMatching(
          /^\$\{ISOMUX_SITE_UID(:\?[^}]*)?\}:\$\{ISOMUX_SITE_GID(:\?[^}]*)?\}$/,
        ),
      });
      expect({ ...where, ports: service.ports }).toEqual({
        ...where,
        ports: undefined,
      });
      expect(service.network_mode).toBeUndefined();
    }
  });

  it("gives the site no route out except the egress proxy", () => {
    const site = services.site;
    expect(site).toBeDefined();
    const siteNetworks = networksOf(site);
    expect(siteNetworks.length).toBeGreaterThan(0);
    for (const network of siteNetworks)
      expect({ network, internal: internal(network) }).toEqual({
        network,
        internal: true,
      });
    // Every proxy variable names the egress service, on a network the two share.
    const siteEnv = env(site);
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY"])
      expect({ key, value: siteEnv[key] }).toEqual({
        key,
        value: expect.stringMatching(/^http:\/\/egress:\d+$/),
      });
    const shared = networksOf(services.egress).filter((network) =>
      siteNetworks.includes(network),
    );
    expect(shared.length).toBeGreaterThan(0);
  });

  it("lets the egress proxy reach only the two hosts the chat calls", () => {
    const allow = env(services.egress).EGRESS_ALLOW ?? "";
    expect(
      allow
        .split(",")
        .map((entry) => entry.trim())
        .sort(),
    ).toEqual(["api.anthropic.com:443", "discord.com:443"]);
  });
});

describe("the site socket", () => {
  it("is the one path that compose, Caddy and tmpfiles name", () => {
    const site = services.site;
    expect(site).toBeDefined();
    const command = Array.isArray(site.command)
      ? site.command
      : (site.command ?? "").split(/\s+/);
    const socket = command[command.indexOf("--socket") + 1];
    expect(socket).toMatch(/^\/run\/[^/]+\/[^/]+\.sock$/);
    const socketDir = socket.slice(0, socket.lastIndexOf("/"));

    // compose bind-mounts the directory into the container at the same path.
    const mounts = (site.volumes ?? []).map((volume) =>
      typeof volume === "string"
        ? { source: volume.split(":")[0], target: volume.split(":")[1] }
        : volume,
    );
    expect(mounts).toContainEqual(
      expect.objectContaining({ source: socketDir, target: socketDir }),
    );

    for (const file of ["isomux-site.caddy", "isomux-site.stage.caddy"]) {
      const caddy = readFileSync(join(dir, file), "utf8");
      expect({
        file,
        upstream: caddy.match(/reverse_proxy\s+(\S+)/)?.[1],
      }).toEqual({ file, upstream: `unix/${socket}` });
    }

    const tmpfiles = readFileSync(
      join(dir, "isomux-site.tmpfiles.conf"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));
    expect(tmpfiles).toHaveLength(1);
    expect(tmpfiles[0].split(/\s+/).slice(0, 2)).toEqual(["d", socketDir]);
  });
});
