import { describe, expect, test } from "bun:test";
import {
  baselineMatrix,
  baselineOptionsSchema,
  methodConfigIdentity,
  methodManifest,
  methodManifestSchema,
} from "../../src/baselines/catalog";

describe("research baseline catalog", () => {
  test("confirmed chapter matrices and explicit AutoML identity", () => {
    expect(baselineMatrix("analysis")).toEqual([
      "react",
      "autogen",
      "datawiseagent",
    ]);
    expect(baselineMatrix("modeling")).toEqual([
      ...baselineMatrix("analysis"),
      "autogluon",
    ]);
    for (const id of baselineMatrix("modeling")) {
      const m = methodManifest(id);
      expect(methodManifestSchema.parse(m)).toEqual(m);
      expect(m.outputs.includes("report")).toBe(id !== "autogluon");
      expect(m.model).toBe(id === "autogluon" ? "none" : "configurable");
    }
  });
  test("rejects unknown methods, fields and privilege/config overrides", () => {
    expect(() => methodManifest("pure-llm")).toThrow();
    const config = { schema_version: 1, method: "react", image: "fixture" };
    for (const field of [
      "command",
      "environment",
      "base_url",
      "model",
      "total_tokens",
    ]) {
      expect(() =>
        baselineOptionsSchema.parse({ ...config, [field]: "override" }),
      ).toThrow();
    }
    expect(() =>
      baselineOptionsSchema.parse({ ...config, backend: "fresh-script" }),
    ).toThrow();
    expect(() =>
      baselineOptionsSchema.parse({ ...config, limits: { cpus: 0 } }),
    ).toThrow();
    expect(() =>
      methodManifestSchema.parse({
        ...methodManifest("autogluon"),
        outputs: ["report"],
      }),
    ).toThrow();
    expect(() =>
      methodManifestSchema.parse({ ...methodManifest("react"), ready: true }),
    ).toThrow();
  });
  test("configuration identity includes effective defaults and method differences", () => {
    const c = { schema_version: 1, method: "react", image: "fixture" };
    expect(methodConfigIdentity(c)).toBe(
      methodConfigIdentity({ ...c, max_turns: 30 }),
    );
    expect(methodConfigIdentity(c)).not.toBe(
      methodConfigIdentity({ ...c, max_turns: 31 }),
    );
    expect(methodConfigIdentity(c)).not.toBe(
      methodConfigIdentity({ ...c, image: "other" }),
    );
    expect(methodConfigIdentity(c)).not.toBe(
      methodConfigIdentity({ ...c, method: "autogen" }),
    );
    const manifest = methodManifest("react");
    manifest.deviations.length = 0;
    expect(methodManifest("react").deviations.length).toBeGreaterThan(0);
  });
});
