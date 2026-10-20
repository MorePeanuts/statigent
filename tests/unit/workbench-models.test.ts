import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModelOptions, modelOptions } from "../../src/workbench/models";

function profile(id: string, keyEnv: string) {
  return {
    id,
    provider: "deepseek",
    protocol: "chat-completions",
    base_url: "https://api.example.invalid",
    model: `${id}-upstream-name`,
    display_name: `Model ${id}`,
    api_key_env: keyEnv,
    capabilities: { tool_calls: true, thinking: true },
    generation: { thinking: "enabled", max_output_tokens: 4096 },
  };
}

const SECRET = "sk-workbench-test-secret-value";

test("options expose only id, name, capabilities and key presence", () => {
  const options = modelOptions(
    [profile("alpha", "ALPHA_KEY"), profile("beta", "BETA_KEY")],
    { ALPHA_KEY: SECRET, UNRELATED_TOKEN: "other-secret" },
  );
  expect(options).toEqual([
    {
      id: "alpha",
      display_name: "Model alpha",
      capabilities: { tool_calls: true, thinking: true, vision: false },
      key_present: true,
    },
    {
      id: "beta",
      display_name: "Model beta",
      capabilities: { tool_calls: true, thinking: true, vision: false },
      key_present: false,
    },
  ]);
  const serialized = JSON.stringify(options);
  for (const hidden of [
    SECRET,
    "other-secret",
    "ALPHA_KEY",
    "api.example.invalid",
    "upstream-name",
    "max_output_tokens",
  ])
    expect(serialized).not.toContain(hidden);
});

test("a key the model client would refuse is reported as absent", () => {
  for (const value of ["", "   ", "line\nbreak"])
    expect(
      modelOptions([profile("alpha", "ALPHA_KEY")], { ALPHA_KEY: value })[0]
        ?.key_present,
    ).toBe(false);
});

test("invalid or duplicate profiles fail instead of being skipped", () => {
  expect(() => modelOptions({})).toThrow("Models must be an array");
  expect(() =>
    modelOptions([profile("alpha", "A"), profile("alpha", "B")]),
  ).toThrow("Duplicate model profile ID");
  expect(() => modelOptions([{ ...profile("alpha", "A"), id: "" }])).toThrow();
});

test("the repository model configuration loads from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workbench-models-"));
  const path = join(directory, "models.json");
  await writeFile(path, JSON.stringify([profile("alpha", "ALPHA_KEY")]));
  expect(await listModelOptions(path, {})).toHaveLength(1);
  expect(
    (await listModelOptions("configs/models.json", {})).map((m) => m.id),
  ).toContain("deepseek-flash");
});
