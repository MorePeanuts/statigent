// Browser-side access to the workbench API. Types come from the server modules (type-only
// imports, erased at build time) so both sides describe the same payloads.
import type { FieldIssue } from "../../src/workbench/agents";
import type { InputFile } from "../../src/workbench/inputs";
import type { ModelOption } from "../../src/workbench/models";
import type { PreflightProblem } from "../../src/workbench/preflight";
import type { ResultSummary } from "../../src/workbench/results";
import type { RunListError, RunSummary } from "../../src/workbench/runs";

export type {
  FieldIssue,
  InputFile,
  ModelOption,
  PreflightProblem,
  ResultSummary,
  RunListError,
  RunSummary,
};
export type { TraceEvent } from "../../src/workbench/events";

/** A failed API call with whatever structured detail the server sent. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
  }
  if (!response.ok)
    throw new ApiError(
      typeof body.error === "string" ? body.error : `HTTP ${response.status}`,
      response.status,
      body,
    );
  return body as T;
}

export const api = {
  models: () => request<{ models: ModelOption[] }>("/api/models"),
  inputs: () => request<{ inputs: InputFile[] }>("/api/inputs"),
  upload: (file: File) =>
    request<{ input: InputFile }>(
      `/api/inputs?name=${encodeURIComponent(file.name)}`,
      { method: "POST", body: file },
    ),
  deleteInput: (name: string) =>
    request<Record<string, never>>(`/api/inputs/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  runs: () =>
    request<{ runs: RunSummary[]; errors: RunListError[] }>("/api/runs"),
  run: (id: string) =>
    request<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}`),
  submit: (payload: unknown) =>
    request<{ run_id: string }>("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  cancel: (id: string) =>
    request<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  result: (id: string) =>
    request<{ result: ResultSummary }>(
      `/api/runs/${encodeURIComponent(id)}/result`,
    ),
};

export const artifactUrl = (runId: string, artifactId: string) =>
  `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;

export const fileUrl = (runId: string, path: string, download = false) =>
  `/api/runs/${encodeURIComponent(runId)}/files/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${download ? "?download=1" : ""}`;

export async function artifactText(
  runId: string,
  artifactId: string,
): Promise<string> {
  const response = await fetch(artifactUrl(runId, artifactId));
  if (!response.ok)
    throw new Error(`Artifact unavailable (${response.status})`);
  return response.text();
}
