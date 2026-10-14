import { expect, test } from "bun:test";
import { parsePositionals, parseStrictOptions } from "../../src/cli-options";

test("Commander rejects ambiguous flags before any command work", () => {
  const options = ["--task", "--runs"];
  expect(
    parseStrictOptions(
      ["--task", "task.json", "--preflight", "--runs", "runs"],
      options,
      "invalid options",
      ["--preflight"],
    ),
  ).toEqual({
    "--task": "task.json",
    "--preflight": "true",
    "--runs": "runs",
  });
  for (const args of [
    ["--task", "a", "--task", "b"],
    ["--preflight", "--preflight"],
    ["--task", "--runs", "runs"],
    ["--unknown", "value"],
    ["stray"],
  ])
    expect(() =>
      parseStrictOptions(args, options, "invalid options", ["--preflight"]),
    ).toThrow("invalid options");
});

test("Commander checks required and excess positional arguments", () => {
  expect(
    parsePositionals(["demo", "runs"], "<command> [root]", "usage"),
  ).toEqual(["demo", "runs"]);
  for (const args of [[], ["demo", "runs", "extra"], ["--unknown"]])
    expect(() => parsePositionals(args, "<command> [root]", "usage")).toThrow(
      "usage",
    );
});
