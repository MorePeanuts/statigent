import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfiguration, parseFlags } from "../../src/agent/cli";
import { preflightInputs, validateTask } from "../../src/agent/config";
import { profile, task } from "../helpers/agent";

test("CLI profile precedence, explicit smoke selection and strict flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "statigent-cli-"));
  try {
    const models = join(root, "models.json");
    const other = { ...profile, id: "other", model: "other-model" };
    await Bun.write(models, JSON.stringify([profile, other]));
    const args = [
      "--task",
      "configs/tasks/synthetic-eda.json",
      "--models",
      models,
    ];
    expect((await loadConfiguration(args)).profile.model).toBe(
      "deepseek-flash",
    );
    expect(
      (await loadConfiguration([...args, "--model", "other"])).profile.model,
    ).toBe("other-model");
    await expect(loadConfiguration(args, true)).rejects.toThrow(
      "explicit --model",
    );
    expect(() => parseFlags([...args, "--models", models])).toThrow("unique");
    expect(() =>
      validateTask({ ...task, execution: { ...task.execution, inputs: [] } }),
    ).toThrow();
    await expect(
      preflightInputs(
        validateTask({
          ...task,
          execution: { ...task.execution, inputs: ["nonexistent.csv"] },
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("CLI missing credentials fails before container and logs no secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "statigent-cli-key-"));
  try {
    const models = join(root, "models.json");
    await Bun.write(
      models,
      JSON.stringify([
        { ...profile, api_key_env: "STATIGENT_REQUIRED_TEST_KEY_MISSING" },
      ]),
    );
    const p = Bun.spawn(
      [
        "bun",
        "src/agent/cli.ts",
        "run",
        "--task",
        "configs/tasks/synthetic-eda.json",
        "--models",
        models,
        "--runs",
        join(root, "runs"),
      ],
      { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(code).toBe(1);
    expect(err).toContain("STATIGENT_REQUIRED_TEST_KEY_MISSING");
    expect(out).toContain("model_attempts");
    expect(await Bun.file(join(root, "runs")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
