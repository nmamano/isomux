// The VPS deploy target (control-plane/deploy/vps/), held by its structure.
//
// The acceptance evidence is the bring-up, vps/local-proof.sh. These checks
// keep the properties that a later edit could lose without the bring-up
// noticing: the database stays unreachable from outside its network, each
// service keeps its ceiling, the owner CLI stays away from provider values,
// and the committed templates stay placeholders.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { shipsToImage } from "./build-context.ts";
import {
  CERTIFICATE_SECRET_NAMES,
  CONTABO_SECRET_NAMES,
  STRIPE_CONFIGURATION_NAMES,
} from "./secret-names.ts";
import { WELCOME_MAIL_KEY_ENV } from "../welcome-mail.ts";

const VPS = path.join(import.meta.dir, "vps");

type Service = {
  image?: string;
  ports?: string[];
  networks?: string[];
  volumes?: string[];
  env_file?: string | string[];
  environment?: Record<string, string>;
  profiles?: string[];
  cap_drop?: string[];
  cpus?: number;
  mem_limit?: string;
  memswap_limit?: string;
  logging?: { driver: string; options: { tag: string } };
};

const compose = Bun.YAML.parse(
  fs.readFileSync(path.join(VPS, "compose.yaml"), "utf8"),
) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean }>;
};
const { services } = compose;

function envFiles(service: Service): string[] {
  const value = service.env_file ?? [];
  return (Array.isArray(value) ? value : [value]).map((file) =>
    file.replace(/^\$\{ISOMUX_HOSTED_ENV_DIR:\?\}\//, ""),
  );
}

function envTemplate(name: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of fs
    .readFileSync(path.join(VPS, name), "utf8")
    .split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    entries.set(line.slice(0, at), line.slice(at + 1));
  }
  return entries;
}

describe("the compose project", () => {
  test("app journals use stable service tags and do not change db or owner logging", () => {
    for (const service of ["provisioner", "web"]) {
      expect(services[service].logging).toEqual({
        driver: "journald",
        options: { tag: `\${ISOMUX_HOSTED_PROJECT:-isomux-hosted}-${service}` },
      });
    }
    expect(services.db.logging).toBeUndefined();
    expect(services.owner.logging).toBeUndefined();
  });
  test("has the three services and the owner CLI, nothing else", () => {
    expect(Object.keys(services).sort()).toEqual([
      "db",
      "owner",
      "provisioner",
      "web",
    ]);
  });

  test("the database publishes nothing and sits only on an internal network", () => {
    expect(services.db.ports).toBeUndefined();
    expect(services.db.networks).toEqual(["db"]);
    expect(compose.networks.db.internal).toBe(true);
  });

  test("the database is PostgreSQL 18.6, pinned by digest, data on the image's volume path", () => {
    expect(services.db.image).toMatch(
      /^postgres:18\.6-[a-z]+@sha256:[0-9a-f]{64}$/,
    );
    expect(services.db.volumes).toEqual(["pgdata:/var/lib/postgresql"]);
  });

  test("every published port is on loopback", () => {
    const published = Object.values(services).flatMap((s) => s.ports ?? []);
    expect(published.length).toBe(2);
    for (const port of published) expect(port).toStartWith("127.0.0.1:");
  });

  test("each service has a ceiling and no swap beyond it", () => {
    // The figures are sizing policy (control-plane/README.md); what must hold
    // is that every service has them.
    for (const [name, service] of Object.entries(services)) {
      expect({
        name,
        cpus: typeof service.cpus === "number" && service.cpus > 0,
        memory: /^\d+[mg]$/.test(service.mem_limit ?? ""),
        swap: service.memswap_limit === service.mem_limit,
      }).toEqual({ name, cpus: true, memory: true, swap: true });
    }
  });

  test("the provisioner state root is a named volume at the image's home", () => {
    expect(services.provisioner.volumes).toEqual(["provisioner-state:/data"]);
  });

  test("the owner CLI reaches only the database, with only the owner's values", () => {
    const owner = services.owner;
    expect(owner.profiles).toEqual(["owner"]);
    expect(owner.networks).toEqual(["db"]);
    expect(owner.ports).toBeUndefined();
    expect(owner.volumes).toBeUndefined();
    expect(envFiles(owner)).toEqual(["generated/owner-db.env"]);
  });

  test("the runtimes read their own values and never another service's DSN", () => {
    expect(envFiles(services.web)).toEqual([
      "web.env",
      "generated/web-db.env",
      "generated/seam.env",
    ]);
    expect(envFiles(services.provisioner)).toEqual([
      "provisioner.env",
      "generated/provisioner-db.env",
      "generated/seam.env",
    ]);
    expect(envFiles(services.db)).toEqual(["generated/db.env"]);
  });

  test("the app containers drop every capability", () => {
    for (const name of ["provisioner", "web", "owner"]) {
      expect(services[name].cap_drop).toEqual(["ALL"]);
    }
  });

  test("the runtimes name the VPS production runtime", () => {
    const runtimeOf = (name: string) =>
      services[name].environment?.ISOMUX_PRODUCTION_RUNTIME;
    expect(["provisioner", "web", "owner", "db"].map(runtimeOf)).toEqual([
      "vps",
      "vps",
      undefined,
      undefined,
    ]);
  });
});

describe("the images' run-time users", () => {
  // The user of an image's last stage: the last USER line after the last FROM.
  function finalUser(dockerfile: string): string | undefined {
    const lines = fs
      .readFileSync(dockerfile, "utf8")
      .split("\n")
      .map((line) => line.trim());
    const lastFrom = lines.findLastIndex((line) => /^FROM\s/i.test(line));
    return lines
      .slice(lastFrom)
      .findLast((line) => /^USER\s/i.test(line))
      ?.replace(/^USER\s+/i, "");
  }

  // On the VPS, Docker maps no user namespace: a container uid is the host
  // uid. 0 is host root and 1000 is the host's login user (ubuntu), so an
  // escape as either owns the host or that user's files. The two apps differ
  // so that an escape from the public storefront does not own the
  // provisioner's state volume. Numeric, so the uid needs no passwd lookup to
  // read from the image.
  test("each app runs as its own numeric uid:gid, never root or the host login user", () => {
    const users = {
      web: finalUser(path.join(VPS, "web.Dockerfile")) ?? "",
      provisioner: finalUser(path.join(import.meta.dir, "Dockerfile")) ?? "",
    };
    const ids: Record<string, number[]> = {};
    for (const [name, user] of Object.entries(users)) {
      expect({ name, user }).toEqual({
        name,
        user: expect.stringMatching(/^\d+:\d+$/),
      });
      ids[name] = user.split(":").map(Number);
      for (const id of ids[name]) {
        expect({ name, id, forbidden: id === 0 || id === 1000 }).toEqual({
          name,
          id,
          forbidden: false,
        });
      }
    }
    expect(ids.web[0]).not.toBe(ids.provisioner[0]);
    expect(ids.web[1]).not.toBe(ids.provisioner[1]);
  });
});

describe("the committed templates", () => {
  // A value is a placeholder, empty, or a public constant the code pins.
  const allowed =
    /^(|replace-with-[a-z-]+|[a-z]+@example\.com|https:\/\/[a-z.]+\.example\.com(\/[a-z/]*)?|test|production|1|https:\/\/acme-v02\.api\.letsencrypt\.org\/directory|https:\/\/api\.cloudflare\.com\/client\/v4)$/;

  test("every env template value is a placeholder or a public constant", () => {
    for (const name of ["web.env.example", "provisioner.env.example"]) {
      for (const [key, value] of envTemplate(name)) {
        expect({ name, key, allowed: allowed.test(value) }).toEqual({
          name,
          key,
          allowed: true,
        });
      }
    }
  });

  test("the provisioner template names every secret and certificate setting", () => {
    const names = [...envTemplate("provisioner.env.example").keys()].sort();
    // The public certificate settings that control-plane/cli.ts reads.
    const certificateSettings = [
      "ISOMUX_CERT_TARGET",
      "ISOMUX_ACME_DIRECTORY",
      "ISOMUX_CF_API",
      "ISOMUX_CERTIFICATE_ENDPOINT",
      "ISOMUX_CERTIFICATE_LIVE",
    ];
    expect(names).toEqual(
      [
        ...STRIPE_CONFIGURATION_NAMES,
        ...CONTABO_SECRET_NAMES,
        ...CERTIFICATE_SECRET_NAMES,
        ...certificateSettings,
        WELCOME_MAIL_KEY_ENV,
      ].sort(),
    );
  });

  test("the Caddy sites are example hostnames on loopback upstreams", () => {
    const caddy = fs.readFileSync(
      path.join(VPS, "hosted.caddy.example"),
      "utf8",
    );
    const sites = [...caddy.matchAll(/^(\S+) \{$/gm)].map((m) => m[1]);
    expect(sites).toEqual([
      "https://storefront.example.com",
      "https://provisioner.example.com",
    ]);
    const upstreams = [...caddy.matchAll(/reverse_proxy (\S+)/g)].map(
      (m) => m[1],
    );
    expect(upstreams).toEqual(["127.0.0.1:3100", "127.0.0.1:4311"]);
  });
});

describe("the storefront image's build context", () => {
  const rules = fs
    .readFileSync(path.join(VPS, "web.Dockerfile.dockerignore"), "utf8")
    .split("\n");
  const ships = (file: string) => shipsToImage(rules, file);

  test("carries the web package and the control-plane modules it imports", () => {
    for (const file of [
      "control-plane/web/package.json",
      "control-plane/web/app/page.tsx",
      "control-plane/store.ts",
      "control-plane/stripe/mode.ts",
      "control-plane/deploy/vercel-root/package.json",
    ]) {
      expect({ file, ships: ships(file) }).toEqual({ file, ships: true });
    }
  });

  test("leaves out installs, build output, tests and the rest of the repository", () => {
    for (const file of [
      "control-plane/web/node_modules/next/package.json",
      "control-plane/node_modules/pg/package.json",
      "control-plane/web/.next/BUILD_ID",
      "control-plane/store.test.ts",
      "control-plane/web/app/home-view.test.tsx",
      "control-plane/web/e2e/signup-flow.e2e.ts",
      "server/index.ts",
      "middleware.ts",
      "package.json",
      ".git/config",
    ]) {
      expect({ file, ships: ships(file) }).toEqual({ file, ships: false });
    }
  });
});
