// SPDX-License-Identifier: AGPL-3.0-only
// Iframe entry: relays run requests from the embedding page to a Web Worker,
// one at a time, and kills the worker when a script exceeds its budget.
// Inlined so the worker starts from a blob URL: a blob worker inherits this page's
// Content-Security-Policy, which is what keeps user scripts off the network on any static host.
import RunnerWorker from "./worker?worker&inline";
import {
  PROTOCOL_VERSION,
  isDataResponse,
  isRunRequest,
  type DataRequest,
  type RunReply,
  type RunRequest,
  type RunnerToHost,
} from "./protocol";

const pinetsVersion = __PINETS_VERSION__;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
/** How long the embedder may take to answer one data request. */
const DATA_TIMEOUT_MS = 15_000;

interface Job {
  request: RunRequest;
  post: (message: RunnerToHost) => void;
  /** Compute budget left; time spent waiting for the embedder's data does not count. */
  remainingMs: number;
  resumedAt: number;
  waitingForData: Map<string, number>;
}

let worker: Worker | null = null;
let active: Job | null = null;
let timer: number | null = null;
const queue: Job[] = [];

function failure(id: string, message: string): RunReply {
  return { type: "pine-runner:result", id, ok: false, error: { message } };
}

function createWorker(): Worker {
  const next = new RunnerWorker();
  next.onmessage = (event: MessageEvent<RunReply | DataRequest>) => {
    if (event.data.type === "pine-runner:data-request") forwardDataRequest(event.data);
    else finish(event.data);
  };
  next.onerror = (event) => {
    finish(failure(active?.request.id ?? "", event.message || "worker crashed"));
    recycle();
  };
  return next;
}

function recycle(): void {
  worker?.terminate();
  worker = null;
}

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function startTimer(job: Job): void {
  job.resumedAt = performance.now();
  timer = window.setTimeout(() => {
    recycle();
    finish(failure(job.request.id, "script exceeded its time budget"));
  }, job.remainingMs);
}

function forwardDataRequest(message: DataRequest): void {
  const job = active;
  if (!job || message.runId !== job.request.id) return;
  if (job.waitingForData.size === 0) {
    stopTimer();
    job.remainingMs = Math.max(1, job.remainingMs - (performance.now() - job.resumedAt));
  }
  const dataTimer = window.setTimeout(() => {
    settleData(job, message.requestId);
    worker?.postMessage({
      type: "pine-runner:data-response",
      runId: message.runId,
      requestId: message.requestId,
      ok: false,
      error: "data request timed out",
    });
  }, DATA_TIMEOUT_MS);
  job.waitingForData.set(message.requestId, dataTimer);
  job.post(message);
}

function settleData(job: Job, requestId: string): boolean {
  const dataTimer = job.waitingForData.get(requestId);
  if (dataTimer === undefined) return false;
  clearTimeout(dataTimer);
  job.waitingForData.delete(requestId);
  if (job.waitingForData.size === 0 && active === job) startTimer(job);
  return true;
}

function finish(message: RunReply): void {
  stopTimer();
  const job = active;
  active = null;
  if (job) {
    for (const dataTimer of job.waitingForData.values()) clearTimeout(dataTimer);
    if (message.id === job.request.id) job.post(message);
  }
  pump();
}

function pump(): void {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  active = job;
  worker ??= createWorker();
  startTimer(job);
  worker.postMessage(job.request);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!event.source) return;
  if (isDataResponse(event.data)) {
    // Only the answer to a request this run is waiting for reaches the worker.
    if (active && event.data.runId === active.request.id && settleData(active, event.data.requestId)) {
      worker?.postMessage(event.data);
    }
    return;
  }
  if (!isRunRequest(event.data)) return;
  const source = event.source as Window;
  const origin = event.origin === "null" ? "*" : event.origin;
  queue.push({
    request: event.data,
    post: (message) => source.postMessage(message, origin),
    remainingMs: Math.min(event.data.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    resumedAt: 0,
    waitingForData: new Map(),
  });
  pump();
});

window.parent.postMessage(
  { type: "pine-runner:ready", protocol: PROTOCOL_VERSION, pinets: pinetsVersion },
  "*",
);
