import { expect, test } from "bun:test";
import {
  roleTools,
  validateRoleAction,
} from "../../src/agent/collaboration-actions";
import {
  ROLE_PROMPT_VERSIONS,
  ROLE_PROMPTS,
  roleInitialMessages,
} from "../../src/agent/collaboration-prompt";
import { validateTask } from "../../src/agent/config";
import { sha256 } from "../../src/records/store";
import { task } from "../helpers/agent";

const result = {
  subtask_id: "s1",
  status: "completed",
  summary: "mean 2",
  findings: [{ statement: "mean", evidence_refs: ["old-cell"], value: 2 }],
  methods: ["all rows"],
  limitations: [],
  diagnostic: null,
};
const validate = (
  role: "planner" | "executor",
  name: string,
  value: unknown,
  subtask: string | null = role === "planner" ? null : "s1",
) =>
  validateRoleAction(
    role,
    name,
    JSON.stringify(value),
    new Set(["old-cell"]),
    1,
    1000,
    subtask,
    false,
  );

test("role tool permissions, current identity, evidence and diagnostic contract", () => {
  expect(validate("executor", "return_result", result).kind).toBe("return");
  expect(() => validate("executor", "return_result", result, "s2")).toThrow(
    "identity",
  );
  expect(() => validate("executor", "return_result", result, null)).toThrow(
    "active",
  );
  expect(() => validate("executor", "finish_analysis", result)).toThrow(
    "not allowed",
  );
  expect(() => validate("planner", "execute_python", { code: "x=1" })).toThrow(
    "not allowed",
  );
  expect(() =>
    validate("executor", "return_result", {
      ...result,
      findings: [{ statement: "foreign", evidence_refs: ["foreign"] }],
    }),
  ).toThrow("evidence");
  const partial = {
    ...result,
    status: "needs_clarification",
    findings: [],
    methods: [],
    diagnostic: "Which date defines a sale?",
  };
  expect(validate("executor", "return_result", partial).kind).toBe("return");
  expect(() =>
    validate("executor", "return_result", { ...partial, diagnostic: null }),
  ).toThrow("Diagnostic");
  expect(() =>
    validate("executor", "return_result", { ...partial, status: "completed" }),
  ).toThrow("Findings");
  for (const question of [
    "Analyze sales",
    "Decompose volume versus price",
    "Read csv",
  ]) {
    expect(
      validate("planner", "delegate_analysis", {
        task: question,
        constraints: [],
      }).kind,
    ).toBe("delegate");
  }
});

test("role prompts and tools expose only their responsibilities and carry global constraints", () => {
  const t = validateTask({
    ...task,
    organization: "planner-executor",
    constraints: ["Never change refund definition"],
  });
  const planner = roleInitialMessages(t, "planner"),
    executor = roleInitialMessages(t, "executor");
  expect(planner[0]?.content).not.toBe(executor[0]?.content);
  for (const role of ["planner", "executor"] as const) {
    expect(ROLE_PROMPT_VERSIONS[role]).toContain(role);
    expect(sha256(Buffer.from(ROLE_PROMPTS[role]))).toHaveLength(64);
    expect(JSON.stringify(roleInitialMessages(t, role))).toContain(
      "Never change refund definition",
    );
  }
  expect(JSON.stringify(roleTools("planner", false))).not.toContain(
    '"name":"execute_python"',
  );
  expect(JSON.stringify(roleTools("executor", false))).not.toContain(
    '"name":"finish_analysis"',
  );
});
