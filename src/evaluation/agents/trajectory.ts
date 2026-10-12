import { obj } from "../../models/validation";
import { readEvents } from "../../records/store";

export const TRAJECTORY_FORMAT = "trajectory-v1";
export const COLLABORATION_MAPPING = "planner-executor-v1";
export const TRAJECTORY_LIMIT = 256 * 1024;
interface Step {
  seq: number;
  cell: string;
  code: string;
  status: string;
  output: string;
  truncated: boolean;
  subtask: string | null;
}
/** Keeps the start and end of an oversized trajectory and marks what was cut from the middle. */
export function truncateMiddle(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  const marker = (n: number) =>
    `\n\n[... ${n} bytes omitted from the middle (${TRAJECTORY_FORMAT} limit) ...]\n\n`;
  const keep = limit - Buffer.byteLength(marker(bytes.length));
  const head = Math.floor(keep / 2),
    tail = keep - head;
  // Decoding may drop a split multi-byte character at either cut, which only shortens the text.
  return (
    bytes.subarray(0, head).toString("utf8").replace(/�$/, "") +
    marker(bytes.length - head - tail) +
    bytes
      .subarray(bytes.length - tail)
      .toString("utf8")
      .replace(/^�/, "")
  );
}
/**
 * Unified trajectory for upstream-compatible scoring: executed cells in execution order (code, status,
 * bounded output preview) followed by the final report. Only container-visible text is used; any host
 * path in `scrub` is replaced before delivery.
 */
export async function buildTrajectory(
  runDirectory: string,
  report: string | null,
  scrub: string[] = [],
  limit = TRAJECTORY_LIMIT,
): Promise<string> {
  const steps = new Map<string, Step>();
  for (const event of await readEvents(runDirectory)) {
    if (event.type === "dispatch" && event.request) {
      const r = obj(event.request);
      steps.set(String(r.request_id), {
        seq: Number(r.execution_seq),
        cell: String(r.cell_id),
        code: String(r.code ?? ""),
        status: "not_finished",
        output: "",
        truncated: false,
        subtask:
          event.role === "executor" && typeof event.subtask_id === "string"
            ? event.subtask_id
            : null,
      });
    }
    if (event.type === "finish" && event.result) {
      const r = obj(event.result);
      const step = steps.get(String(r.request_id));
      if (step) {
        step.status = String(r.status);
        step.output = String(r.preview ?? "");
        step.truncated = r.preview_truncated === true;
      }
    }
  }
  const lines = [`# Analysis trajectory (${TRAJECTORY_FORMAT})`, ""];
  if ([...steps.values()].some((s) => s.subtask))
    lines.push(
      `Mapping: ${COLLABORATION_MAPPING}; executed cells only; final report authored by planner.`,
      "",
    );
  for (const [index, s] of [...steps.values()]
    .sort((a, b) => a.seq - b.seq)
    .entries())
    lines.push(
      `## Step ${index + 1} (cell ${s.cell}, status ${s.status})`,
      "",
      ...(s.subtask ? [`Role: executor; subtask: ${s.subtask}`, ""] : []),
      "### Code",
      "",
      "```python",
      s.code,
      "```",
      "",
      `### Output${s.truncated ? " (preview truncated)" : ""}`,
      "",
      "```text",
      s.output,
      "```",
      "",
    );
  lines.push("## Final report", "", report ?? "(no report delivered)", "");
  let text = lines.join("\n");
  for (const path of scrub.filter((p) => p.length > 1))
    text = text.split(path).join("[host]");
  return truncateMiddle(text, limit);
}
