import { describe, expect, it } from "bun:test";
import {
  CLAUDE_CLOUD_MODEL_DEFAULTS,
  FAMILY_TO_MODEL,
} from "../../shared/types.ts";
import {
  claudeFamilyModels,
  limitedClaudeFamilies,
  withCloudModelDefaults,
} from "./claude-install-check.ts";

describe("Claude cloud defaults", () => {
  it("keeps each cloud row aligned with the picker model", () => {
    for (const [family, row] of Object.entries(CLAUDE_CLOUD_MODEL_DEFAULTS)) {
      const model = FAMILY_TO_MODEL[family as keyof typeof FAMILY_TO_MODEL];
      expect(model).toBe(row.vertex);
      for (const id of Object.values(row.bedrock)) expect(id).toContain(model);
    }
  });

  for (const [region, sonnet, haiku] of [
    ["us-west-2", "us", "us"],
    ["ca-central-1", "us", "us"],
    ["eu-west-1", "eu", "eu"],
    ["ap-northeast-1", undefined, "jp"],
    ["ap-southeast-2", "au", "au"],
    ["ap-southeast-1", undefined, undefined],
    ["us-gov-west-1", undefined, undefined],
    ["unlisted", undefined, undefined],
    [undefined, undefined, undefined],
  ] as const) {
    it(`resolves Bedrock defaults and metadata for ${region ?? "no region"}`, () => {
      const env = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: region };
      const resolved = withCloudModelDefaults(env);
      const expectedModels: Record<string, string> = {};
      const limited: string[] = [];
      for (const [family, geo] of [
        ["sonnet", sonnet],
        ["haiku", haiku],
      ] as const) {
        const id = geo ? `${geo}.anthropic.claude-${family}-5-5` : undefined;
        expect(
          resolved[`ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`],
        ).toBe(id);
        expectedModels[family] = id ?? `claude-${family}-4-5`;
        if (!geo) limited.push(family);
      }
      expect(claudeFamilyModels(env)).toEqual(expectedModels);
      expect(limitedClaudeFamilies(env)).toEqual(limited);
      expect(resolved.AWS_REGION).toBe(region);
      expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: region });
      expect(resolved.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
      expect(resolved.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined();
    });
  }

  it("honors AWS_DEFAULT_REGION and AWS_REGION precedence", () => {
    for (const [primary, fallback, geo] of [
      [undefined, "eu-west-1", "eu"],
      ["us-east-1", "eu-west-1", "us"],
      ["  ", " eu-west-1 ", undefined],
      ["invalid_region", "eu-west-1", "eu"],
      [" eu-west-1 ", undefined, undefined],
      ["unlisted", "eu-west-1", undefined],
    ]) {
      const env = {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: primary,
        AWS_DEFAULT_REGION: fallback,
      };
      expect(withCloudModelDefaults(env).ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        geo ? `${geo}.anthropic.claude-sonnet-5-5` : undefined,
      );
    }
  });

  it("preserves an office's explicit Bedrock profile prefix", () => {
    for (const prefix of ["global", "eu", "custom"]) {
      const env = {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        ANTHROPIC_BEDROCK_REGION_PREFIX: prefix,
      };
      expect(withCloudModelDefaults(env)).toBe(env);
      expect(limitedClaudeFamilies(env)).toEqual(["sonnet", "haiku"]);
      expect(claudeFamilyModels(env)).toEqual({
        sonnet: "claude-sonnet-4-5",
        haiku: "claude-haiku-4-5",
      });
    }
  });

  it("does not inject a Haiku profile across the background model's geography", () => {
    for (const [region, covered] of [
      ["us-west-2", true],
      ["eu-west-1", false],
      ["unknown", false],
      [" eu-west-1 ", true],
      ["invalid_region", true],
      ["  ", true],
    ] as const) {
      const env = {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: region,
      };
      const resolved = withCloudModelDefaults(env);
      expect(resolved.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        "us.anthropic.claude-sonnet-5-5",
      );
      expect(resolved.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
        covered ? "us.anthropic.claude-haiku-5-5" : undefined,
      );
      expect(resolved.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION).toBe(region);
      expect(limitedClaudeFamilies(env)).toEqual(covered ? [] : ["haiku"]);
    }
  });

  for (const region of ["global", "us", "eu", "us-east5", undefined]) {
    it(`gates Vertex defaults on ${region ?? "no region"}`, () => {
      const env = { CLAUDE_CODE_USE_VERTEX: " on ", CLOUD_ML_REGION: region };
      const resolved = withCloudModelDefaults(env);
      const covered = ["global", "us", "eu"].includes(region ?? "");
      expect(resolved.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        covered ? "claude-sonnet-5-5" : undefined,
      );
      expect(resolved.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
        covered ? "claude-haiku-5-5" : undefined,
      );
      expect(limitedClaudeFamilies(env)).toEqual(
        covered ? [] : ["sonnet", "haiku"],
      );
      expect(claudeFamilyModels(env)).toEqual(
        covered
          ? {}
          : { sonnet: "claude-sonnet-4-5", haiku: "claude-haiku-4-5" },
      );
      expect(resolved.CLOUD_ML_REGION).toBe(region);
    });
  }

  it("uses each Vertex model region override without changing region variables", () => {
    for (const [base, override, covered] of [
      ["us-east5", "global", true],
      ["global", "us-east5", false],
    ] as const) {
      const env = {
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: base,
        VERTEX_REGION_CLAUDE_5_5_SONNET: override,
        VERTEX_REGION_CLAUDE_HAIKU_5_5: override,
      };
      const resolved = withCloudModelDefaults(env);
      expect(resolved).toMatchObject(env);
      expect(resolved.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(
        covered ? "claude-sonnet-5-5" : undefined,
      );
      expect(resolved.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
        covered ? "claude-haiku-5-5" : undefined,
      );
    }
  });

  it("keeps Vertex region overrides independent between families", () => {
    const env = {
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "us-east5",
      VERTEX_REGION_CLAUDE_5_5_SONNET: "global",
      VERTEX_REGION_CLAUDE_HAIKU_5_5: "us-east5",
    };
    const resolved = withCloudModelDefaults(env);
    expect(resolved.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-5-5");
    expect(resolved.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(limitedClaudeFamilies(env)).toEqual(["haiku"]);
    expect(claudeFamilyModels(env)).toEqual({ haiku: "claude-haiku-4-5" });
  });

  it("preserves explicit pins, including opaque IDs and old models", () => {
    const env = {
      CLAUDE_CODE_USE_BEDROCK: "yes",
      AWS_REGION: "us-east-1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: " us.anthropic.claude-sonnet-4-6 ",
      ANTHROPIC_DEFAULT_HAIKU_MODEL:
        "arn:aws:bedrock:us-east-1:1:application-inference-profile/x",
    };
    expect(withCloudModelDefaults(env)).toEqual(env);
    expect(limitedClaudeFamilies(env)).toEqual(["sonnet", "haiku"]);
    expect(claudeFamilyModels(env)).toEqual({
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL.trim(),
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    });
  });

  for (const blank of [undefined, "", "  "]) {
    it(`fills an unset or blank pin (${JSON.stringify(blank)})`, () => {
      expect(
        withCloudModelDefaults({
          CLAUDE_CODE_USE_BEDROCK: " TRUE ",
          AWS_REGION: "eu-west-1",
          ANTHROPIC_DEFAULT_SONNET_MODEL: blank,
        }).ANTHROPIC_DEFAULT_SONNET_MODEL,
      ).toBe("eu.anthropic.claude-sonnet-5-5");
    });
  }

  it("does not inject into first-party or an explicit personal opt-out", () => {
    for (const value of [undefined, "0", "false", "off"]) {
      const env = { CLAUDE_CODE_USE_BEDROCK: value, AWS_REGION: "us-east-1" };
      expect(withCloudModelDefaults(env)).toBe(env);
      expect(claudeFamilyModels(env)).toEqual({});
    }
  });
});
