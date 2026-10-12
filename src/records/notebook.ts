import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type NotebookOutput, validateOutput } from "../execution/protocol";
import {
  type Manifest,
  object,
  readEvents,
  readManifest,
  textField,
  writeJson,
} from "./store";

export interface NotebookCell {
  cell_type: "code";
  id: string;
  source: string;
  execution_count: number | null;
  metadata: { statigent: Record<string, unknown> };
  outputs: Record<string, unknown>[];
}
export interface Notebook {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: {
    kernelspec: { display_name: string; language: string; name: string };
    language_info: { name: string };
    statigent: Record<string, unknown>;
  };
  cells: NotebookCell[];
}
interface CellState {
  cell: NotebookCell;
  displays: Map<string, Record<string, unknown>[]>;
  pendingClear: boolean;
}
export interface NotebookView {
  notebooks: Map<number, Notebook>;
  eligible: boolean;
  reasons: string[];
}

export function buildNotebooks(
  events: Record<string, unknown>[],
  runId: string,
): NotebookView {
  const notebooks = new Map<number, Notebook>();
  const cells = new Map<string, CellState>();
  const reasons = new Set<string>();
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type === "dispatch") {
      const request = event.request ? object(event.request) : event;
      const epoch = Number(request.kernel_epoch);
      const seq = Number(request.execution_seq);
      if (
        !Number.isSafeInteger(epoch) ||
        epoch < 1 ||
        !Number.isSafeInteger(seq) ||
        seq < 1
      )
        throw new Error("Invalid dispatch identity");
      let notebook = notebooks.get(epoch);
      if (!notebook) {
        notebook = {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: {
              display_name: "Python 3",
              language: "python",
              name: "python3",
            },
            language_info: { name: "python" },
            statigent: { run_id: runId, kernel_epoch: epoch },
          },
          cells: [],
        };
        notebooks.set(epoch, notebook);
      }
      const requestId = textField(request.request_id, "request ID");
      if (cells.has(requestId))
        throw new Error("Duplicate dispatch in journal");
      const cellId = textField(request.cell_id, "cell ID");
      const code = request.code ?? event.code;
      if (typeof code !== "string") throw new Error("Invalid code");
      const cell: NotebookCell = {
        cell_type: "code",
        id: cellId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
        source: code,
        execution_count: null,
        metadata: {
          statigent: {
            request_id: requestId,
            cell_id: cellId,
            kernel_epoch: epoch,
            execution_seq: seq,
            started: null,
            status: "unknown",
            persistence_complete: false,
          },
        },
        outputs: [],
      };
      notebook.cells.push(cell);
      cells.set(requestId, { cell, displays: new Map(), pendingClear: false });
    } else if (event.type === "output") {
      const message = event.message ? object(event.message) : event;
      const state = cells.get(String(message.request_id));
      if (!state) {
        reasons.add("unattributed_output");
        continue;
      }
      const output = validateOutput(message.output ?? event.output);
      if (output.output_type === "update_display_data") {
        const displayId = output.transient?.display_id;
        if (displayId) {
          // Display IDs apply to all earlier matching outputs within this kernel epoch.
          for (const candidate of cells.values()) {
            if (
              candidate.cell.metadata.statigent.kernel_epoch !==
              state.cell.metadata.statigent.kernel_epoch
            )
              continue;
            for (const prior of candidate.displays.get(displayId) ?? []) {
              prior.data = output.data;
              prior.metadata = output.metadata;
            }
          }
        }
      } else if (output.output_type === "clear_output") {
        if (output.wait) state.pendingClear = true;
        else {
          state.cell.outputs = [];
          state.displays.clear();
          state.pendingClear = false;
        }
      } else {
        if (state.pendingClear) {
          state.cell.outputs = [];
          state.displays.clear();
          state.pendingClear = false;
        }
        const rendered = renderOutput(
          output,
          Number(state.cell.metadata.statigent.execution_seq),
        );
        state.cell.outputs.push(rendered);
        if (
          (output.output_type === "display_data" ||
            output.output_type === "execute_result") &&
          output.transient?.display_id
        ) {
          const id = output.transient.display_id;
          const matches = state.displays.get(id) ?? [];
          matches.push(rendered);
          state.displays.set(id, matches);
        }
      }
    } else if (event.type === "finish") {
      const result = object(event.result);
      const state = cells.get(String(result.request_id));
      if (!state) continue;
      if (completed.has(String(result.request_id)))
        throw new Error("Duplicate terminal event");
      completed.add(String(result.request_id));
      Object.assign(state.cell.metadata.statigent, {
        started: result.started,
        status: result.status,
        persistence_complete: result.persistence_complete,
        preview_truncated: result.preview_truncated ?? false,
      });
      if (result.started === false) {
        state.cell.execution_count = null;
        state.cell.metadata.statigent.dispatched_sequence =
          state.cell.metadata.statigent.execution_seq;
        delete state.cell.metadata.statigent.execution_seq;
      } else if (result.started === true) {
        state.cell.execution_count = Number(
          state.cell.metadata.statigent.execution_seq,
        );
      }
      if (result.status !== "ok") reasons.add(`cell_${String(result.status)}`);
      if (result.persistence_complete !== true)
        reasons.add("persistence_incomplete");
      if (
        result.error &&
        !state.cell.outputs.some((output) => output.output_type === "error")
      )
        state.cell.outputs.push({
          output_type: "error",
          ...object(result.error),
        });
    } else if (
      event.type === "diagnostic" &&
      event.message &&
      typeof event.message === "object" &&
      object(event.message).persistence_complete === false
    )
      reasons.add("persistence_incomplete");
    else if (event.type === "journal_truncated")
      reasons.add("journal_truncated");
  }
  if (!cells.size) reasons.add("no_executed_cells");
  if (notebooks.size > 1) reasons.add("multiple_kernel_epochs_or_restart");
  for (const [requestId, state] of cells)
    if (!completed.has(requestId)) {
      reasons.add("unfinished_execution");
      state.cell.metadata.statigent.status = "unknown";
    }
  return { notebooks, eligible: reasons.size === 0, reasons: [...reasons] };
}
function renderOutput(
  output: Exclude<NotebookOutput, { output_type: "clear_output" }>,
  executionCount: number,
): Record<string, unknown> {
  if (output.output_type === "stream" || output.output_type === "error")
    return { ...output };
  const rendered: Record<string, unknown> = {
    output_type: output.output_type,
    data: output.data,
    metadata: output.metadata,
  };
  if (output.output_type === "execute_result")
    rendered.execution_count = output.execution_count ?? executionCount;
  return rendered;
}
export async function validateNotebook(notebook: Notebook): Promise<void> {
  const process = Bun.spawn(
    [
      "uv",
      "run",
      "--frozen",
      "python",
      "python/statigent_runtime/notebook.py",
      "validate",
      "-",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => process.kill(), 30000);
  process.stdin.write(JSON.stringify(notebook));
  process.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  clearTimeout(timer);
  if (exit !== 0)
    throw new Error(`Notebook format validation failed: ${stderr.trim()}`);
  if (object(JSON.parse(stdout)).valid !== true)
    throw new Error("Notebook validator did not confirm validity");
}
export async function exportNotebooks(
  directory: string,
  validate: (notebook: Notebook) => Promise<void> = validateNotebook,
): Promise<Manifest["export"]> {
  const manifest = await readManifest(directory);
  try {
    const view = buildNotebooks(await readEvents(directory), manifest.run_id);
    if (!manifest.ended_at) view.reasons.push("run_not_finished");
    if (manifest.status !== "completed") view.reasons.push("run_not_completed");
    view.eligible = view.reasons.length === 0;
    const paths: string[] = [];
    for (const [epoch, notebook] of view.notebooks) {
      await validate(notebook);
      const path = `notebooks/epoch-${epoch}-${randomUUID()}.ipynb`;
      // Each export is a separate view; no previous artifact is overwritten.
      await writeFile(
        join(directory, path),
        `${JSON.stringify(notebook, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      paths.push(path);
    }
    manifest.export = { status: "exported", paths };
    manifest.replay = {
      ...manifest.replay,
      eligible: view.eligible,
      reasons: view.reasons,
    };
    await writeJson(join(directory, "manifest.json"), manifest);
    return manifest.export;
  } catch (error) {
    manifest.export = {
      status: "failed",
      paths: [],
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJson(join(directory, "manifest.json"), manifest);
    throw error;
  }
}
