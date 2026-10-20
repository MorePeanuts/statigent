import { join } from "node:path";
import { type EventCursor, readNewEvents } from "./events";
import { type RunSource, readRun, type StatusView } from "./runs";

// Server-sent events for one run: `trace` frames carry normalized events with their sequence
// number as the SSE ID (so EventSource reconnects resume via Last-Event-ID), `status` frames
// report display status changes, and a final `end` frame closes the stream.

export interface TraceStreamOptions {
  source: RunSource;
  runId: string;
  /** Sequence number the client already has; streaming starts after it. */
  after: number;
  pollMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
}

const ACTIVE = new Set(["starting", "running", "finalizing"]);
const encoder = new TextEncoder();

function frame(event: string, data: unknown, id?: number): Uint8Array {
  const lines = [
    ...(id === undefined ? [] : [`id: ${id}`]),
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
  ];
  return encoder.encode(`${lines.join("\n")}\n\n`);
}

function statusData(view: StatusView | null) {
  return view
    ? {
        status: view.status,
        detail: view.detail,
        cancellable: view.cancellable,
      }
    : {
        status: "unknown",
        detail: "Run record disappeared",
        cancellable: false,
      };
}

export function parseAfter(request: Request): number | null {
  const raw =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("after") ??
    "0";
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function traceStream(
  options: TraceStreamOptions,
): ReadableStream<Uint8Array> {
  const pollMs = options.pollMs ?? 500;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const path = join(options.source.runsRoot, options.runId, "events.jsonl");
  let stopped = false;
  // Set only by cancel(): the consumer already released the stream, so it must not be closed.
  let cancelled = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Not awaited: start() must return so the stream is readable while the loop runs.
      void pump(controller);
    },
    cancel() {
      // The client went away: stop polling instead of reading for nobody.
      cancelled = true;
      stop();
    },
  });
  return stream;

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>) {
    let cursor: EventCursor = { offset: 0, seq: 0 };
    let lastStatus: string | null = null;
    let quietSince = Date.now();
    const send = (bytes: Uint8Array) => {
      if (stopped) return;
      controller.enqueue(bytes);
      quietSince = Date.now();
    };
    const drain = async () => {
      const read = await readNewEvents(path, cursor, options.after);
      cursor = read.cursor;
      for (const event of read.events) send(frame("trace", event, event.seq));
    };
    try {
      while (!stopped) {
        await drain();
        const view = await readRun(options.source, options.runId);
        const status = statusData(view);
        if (status.status !== lastStatus) {
          lastStatus = status.status;
          send(frame("status", status));
        }
        if (!ACTIVE.has(status.status)) {
          // Lines written between the read above and the status check belong to this run.
          await drain();
          send(frame("end", status));
          break;
        }
        if (Date.now() - quietSince >= heartbeatMs) {
          send(encoder.encode(": keep-alive\n\n"));
        }
        await sleep(pollMs);
      }
    } catch (error) {
      console.error(
        `[workbench] trace stream for ${options.runId} failed`,
        error,
      );
      // Not "error": that name is EventSource's own connection-failure event.
      send(frame("stream_error", { error: "Reading the run trace failed" }));
    } finally {
      options.signal?.removeEventListener("abort", stop);
      stopped = true;
      if (!cancelled) controller.close();
    }
  }
}
