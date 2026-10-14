import { type BenchmarkAdapter, validateTask } from "../contracts";
import { describeFile } from "../files";
import { benchmarkRootOptions } from "./options";
export const syntheticBenchmark: BenchmarkAdapter = {
  id: "synthetic-sum",
  version: "1",
  protocol: "synthetic-exact-v1",
  options(value) {
    return benchmarkRootOptions(value);
  },
  async catalog(value) {
    const root = benchmarkRootOptions(value).root;
    const input = await describeFile(root, "data.csv");
    return {
      source_root: root,
      provenance: { version: "synthetic-v1", input },
      tasks: [
        validateTask({
          schema_version: 2,
          id: "sum",
          version: input.sha256,
          goal: "Calculate the sum of the value column in data.csv.",
          constraints: ["Use only the provided CSV."],
          inputs: [input],
          output: { kind: "text", instructions: "@sum[value]" },
        }),
      ],
    };
  },
  async preflight() {},
  async score(_options, _task, submission) {
    return {
      schema_version: 2,
      unit_id: submission.unit_id,
      protocol: this.protocol,
      status: "scored",
      metrics: [
        {
          name: "accuracy",
          value: Number(
            submission.status === "completed" &&
              submission.answer_text === "@sum[3]",
          ),
          minimum: 0,
          maximum: 1,
          direction: "higher",
        },
      ],
      details: { synthetic: true },
      error: null,
      judge: null,
    };
  },
};
