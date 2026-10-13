import { expect, test } from "bun:test";
import { validateTask } from "../../src/agent/config";
import {
  backendLaunch,
  validateImageBackend,
} from "../../src/execution/docker";
import { createSession } from "../../src/execution/factory";
import { scriptConfig } from "../helpers/script";

test("trusted backend launch preserves old image entrypoint and fixes script command", () => {
  expect(backendLaunch(undefined)).toEqual({ options: [], command: [] });
  expect(backendLaunch("persistent-kernel")).toEqual(backendLaunch(undefined));
  expect(backendLaunch("fresh-script")).toEqual({
    options: ["--entrypoint", "uv"],
    command: [
      "run",
      "--offline",
      "--no-sync",
      "--project",
      "/opt/runtime",
      "python",
      "-m",
      "statigent_runtime.script_bridge",
    ],
  });
  for (const command of ["bash", { command: "rm" }, ["python"]])
    expect(() => backendLaunch(command)).toThrow();
  expect(() =>
    createSession({ ...scriptConfig(), backend: "bad" as never }),
  ).toThrow();
  expect(() =>
    validateTask({
      goal: "test",
      backend: "fresh-script",
      execution: { command: "bash" },
    }),
  ).toThrow();
});
test("fresh-script refuses old images while persistent images require no new label", () => {
  expect(() => validateImageBackend("fresh-script", null)).toThrow(
    "protocol v2",
  );
  expect(() =>
    validateImageBackend("fresh-script", { "org.statigent.fresh-script": "1" }),
  ).toThrow();
  expect(() =>
    validateImageBackend("fresh-script", { "org.statigent.fresh-script": "2" }),
  ).not.toThrow();
  expect(() => validateImageBackend(undefined, null)).not.toThrow();
});
