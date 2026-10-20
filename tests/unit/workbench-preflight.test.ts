import { expect, test } from "bun:test";
import { validateProfile } from "../../src/models/config";
import {
  type CommandResult,
  type CommandRunner,
  checkRunPrerequisites,
  runCommand,
} from "../../src/workbench/preflight";

const profile = validateProfile({
  id: "alpha",
  provider: "deepseek",
  protocol: "chat-completions",
  base_url: "https://api.example.invalid",
  model: "alpha-model",
  display_name: "Alpha",
  api_key_env: "ALPHA_KEY",
  capabilities: { tool_calls: true, thinking: true },
  generation: { thinking: "enabled", max_output_tokens: 4096 },
});

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({
  code: 1,
  stdout: "",
  stderr,
});

function docker(responses: {
  version: CommandResult;
  inspect?: CommandResult;
}): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "version") return responses.version;
    if (args[0] === "image" && responses.inspect) return responses.inspect;
    throw new Error(`unexpected command ${args.join(" ")}`);
  };
  return Object.assign(runner, { calls });
}

const key = { ALPHA_KEY: "sk-test" };

test("a ready machine reports no problems", async () => {
  const runner = docker({ version: ok("28.0.1"), inspect: ok("null") });
  expect(
    await checkRunPrerequisites(
      { profile, backend: "persistent-kernel", image: "statigent-runtime:dev" },
      key,
      runner,
    ),
  ).toEqual([]);
  expect(runner.calls.at(-1)).toEqual([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    "statigent-runtime:dev",
  ]);
});

test("a missing key names the variable without revealing other environment values", async () => {
  const problems = await checkRunPrerequisites(
    { profile, backend: "persistent-kernel", image: "statigent-runtime:dev" },
    { OTHER_SECRET: "should-not-appear" },
    docker({ version: ok("28.0.1"), inspect: ok("null") }),
  );
  expect(problems).toEqual([
    {
      code: "model_key_missing",
      message: expect.stringContaining("ALPHA_KEY"),
    },
  ]);
  expect(JSON.stringify(problems)).not.toContain("should-not-appear");
});

test("an unreachable Docker daemon is reported and the image is not inspected", async () => {
  const runner = docker({
    version: failed(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    ),
  });
  const problems = await checkRunPrerequisites(
    { profile, backend: "persistent-kernel", image: "statigent-runtime:dev" },
    {},
    runner,
  );
  expect(problems.map((p) => p.code)).toEqual([
    "model_key_missing",
    "docker_unavailable",
  ]);
  expect(problems[1]?.message).toContain("Cannot connect to the Docker daemon");
  expect(runner.calls).toHaveLength(1);
});

test("a missing image names the image to build", async () => {
  const problems = await checkRunPrerequisites(
    { profile, backend: "persistent-kernel", image: "statigent-runtime:dev" },
    key,
    docker({
      version: ok("28.0.1"),
      inspect: failed("Error: No such image: statigent-runtime:dev"),
    }),
  );
  expect(problems).toEqual([
    {
      code: "image_missing",
      message: expect.stringContaining("statigent-runtime:dev"),
    },
  ]);
});

test("the script backend requires an image labelled for its protocol", async () => {
  const check = (labels: unknown) =>
    checkRunPrerequisites(
      {
        profile,
        backend: "fresh-script",
        image: "statigent-runtime:fresh-script",
      },
      key,
      docker({ version: ok("28.0.1"), inspect: ok(JSON.stringify(labels)) }),
    );
  expect((await check(null)).map((p) => p.code)).toEqual([
    "image_incompatible",
  ]);
  expect(await check({ "org.statigent.fresh-script": "2" })).toEqual([]);
});

test("the default runner reports a missing executable as a failure, not a throw", async () => {
  const result = await runCommand(
    "statigent-command-that-does-not-exist",
    [],
    1000,
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).not.toBe("");
});
