// SPDX-License-Identifier: AGPL-3.0-only
// Iframe entry: relays run requests from the embedding page to a Web Worker,
// one at a time, and kills the worker when a script exceeds its budget.
const pinetsVersion = __PINETS_VERSION__;
import { PROTOCOL_VERSION, isRunRequest, type RunReply, type RunRequest } from "./protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

interface Job {
  request: RunRequest;
  reply: (message: RunReply) => void;
}

let worker: Worker | null = null;
let active: Job | null = null;
let timer: number | null = null;
const queue: Job[] = [];

function createWorker(): Worker {
  const next = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  next.onmessage = (event: MessageEvent<RunReply>) => finish(event.data);
  next.onerror = (event) => {
    finish({
      type: "pine-runner:result",
      id: active?.request.id ?? "",
      ok: false,
      error: { message: event.message || "worker crashed" },
    });
    recycle();
  };
  return next;
}

function recycle(): void {
  worker?.terminate();
  worker = null;
}

function finish(message: RunReply): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const job = active;
  active = null;
  if (job && message.id === job.request.id) job.reply(message);
  pump();
}

function pump(): void {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  active = job;
  worker ??= createWorker();
  const budget = Math.min(job.request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  timer = window.setTimeout(() => {
    recycle();
    finish({
      type: "pine-runner:result",
      id: job.request.id,
      ok: false,
      error: { message: `script exceeded ${budget} ms` },
    });
  }, budget);
  worker.postMessage(job.request);
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isRunRequest(event.data) || !event.source) return;
  const source = event.source as Window;
  const origin = event.origin;
  queue.push({
    request: event.data,
    reply: (message) => source.postMessage(message, origin === "null" ? "*" : origin),
  });
  pump();
});

window.parent.postMessage(
  { type: "pine-runner:ready", protocol: PROTOCOL_VERSION, pinets: pinetsVersion },
  "*",
);
