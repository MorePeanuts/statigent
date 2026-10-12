import { keys, obj, str, strings } from "../models/validation";
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "execute_python",
      description:
        "Execute one Python cell in the persistent isolated kernel. Use /input for inputs and current directory for outputs.",
      parameters: {
        type: "object",
        properties: { code: { type: "string", minLength: 1 } },
        required: ["code"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish_analysis",
      description:
        "Submit evidence-based analysis after successful execution. Reference cell_id or artifact_id from this run.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          findings: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                statement: { type: "string", minLength: 1 },
                value: {},
                evidence_refs: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
              },
              required: ["statement", "evidence_refs"],
              additionalProperties: false,
            },
          },
          methods: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          limitations: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
        required: ["summary", "findings", "methods", "limitations"],
        additionalProperties: false,
      },
    },
  },
] as const;
export interface Analysis {
  summary: string;
  findings: { statement: string; value?: unknown; evidence_refs: string[] }[];
  methods: string[];
  limitations: string[];
}
export type Action =
  | { kind: "execute"; code: string }
  | { kind: "finish"; analysis: Analysis };
export function validateAction(
  name: string,
  args: string,
  evidence: ReadonlySet<string>,
  successfulCells: number,
  codeLimit: number,
): Action {
  const x = obj(JSON.parse(args));
  if (name === "execute_python") {
    keys(x, ["code"]);
    const code = str(x.code, "code");
    if (Buffer.byteLength(code) > codeLimit) throw new Error("code_size_limit");
    return { kind: "execute", code };
  }
  if (name !== "finish_analysis") throw new Error("Unknown tool");
  keys(x, ["summary", "findings", "methods", "limitations"]);
  if (!successfulCells) throw new Error("Successful execution required");
  if (!Array.isArray(x.findings) || !x.findings.length)
    throw new Error("Findings required");
  const findings = x.findings.map((value) => {
    const f = obj(value);
    keys(f, ["statement", "value", "evidence_refs"]);
    const refs = strings(f.evidence_refs, "evidence_refs");
    if (!refs.length || refs.some((ref) => !evidence.has(ref)))
      throw new Error("Invalid or foreign evidence reference");
    return {
      statement: str(f.statement, "statement"),
      ...(f.value !== undefined ? { value: f.value } : {}),
      evidence_refs: refs,
    };
  });
  const methods = strings(x.methods, "methods");
  if (!methods.length) throw new Error("Methods required");
  return {
    kind: "finish",
    analysis: {
      summary: str(x.summary, "summary"),
      findings,
      methods,
      limitations: strings(x.limitations, "limitations"),
    },
  };
}
export function renderAnalysis(analysis: Analysis, runId: string): string {
  const lines = [
    "# 分析报告",
    "",
    `运行：${runId}`,
    "",
    analysis.summary,
    "",
    "## 结论",
    "",
  ];
  for (const f of analysis.findings)
    lines.push(
      `- ${f.statement}`,
      ...(f.value !== undefined
        ? [`  数值：\`${JSON.stringify(f.value)}\``]
        : []),
      `  证据：${f.evidence_refs.map((r) => `\`${r}\``).join(", ")}`,
    );
  lines.push(
    "",
    "## 方法与口径",
    "",
    ...analysis.methods.map((m) => `- ${m}`),
    "",
    "## 局限",
    "",
    ...(analysis.limitations.length
      ? analysis.limitations.map((l) => `- ${l}`)
      : ["未声明额外局限。"]),
    "",
    "Notebook 路径、导出状态与代码重放资格见 manifest.json。证据引用仅证明可追溯，不自动证明推论正确。",
    "",
  );
  return lines.join("\n");
}
