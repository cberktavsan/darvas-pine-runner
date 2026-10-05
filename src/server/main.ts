// SPDX-License-Identifier: AGPL-3.0-only
// HTTP front of the server runner. It runs every script in a fresh child process that has no
// permissions, kills a child that exceeds its time budget, and limits how many run at once.
// Start it with scripts/serve.sh, which grants only what this process needs.
import type { ServerRunResponse } from "./contract";

const PORT = Number(Deno.env.get("PINE_RUNNER_PORT") ?? 8787);
const HOST = Deno.env.get("PINE_RUNNER_HOST") ?? "127.0.0.1";
const TOKEN = Deno.env.get("PINE_RUNNER_TOKEN") ?? "";
const CHILD = Deno.env.get("PINE_RUNNER_CHILD") ?? "";
const MAX_CONCURRENT = Number(Deno.env.get("PINE_RUNNER_CONCURRENCY") ?? 2);
const MAX_WAITING = 32;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const RUN_TIMEOUT_MS = 10_000;
const CHILD_HEAP_MB = 384;
const PINETS_SWITCH = "PINETS_DISABLE_LTF_SLICING";

if (TOKEN.length < 32 || !CHILD) {
  console.error("PINE_RUNNER_TOKEN (32+ characters) and PINE_RUNNER_CHILD are required");
  Deno.exit(1);
}

let running = 0;
const waiting: (() => void)[] = [];

/** Resolves when a run slot is free, or false at once when too many requests already wait. */
async function acquireSlot(): Promise<boolean> {
  if (running < MAX_CONCURRENT) {
    running += 1;
    return true;
  }
  if (waiting.length >= MAX_WAITING) return false;
  await new Promise<void>((resolve) => waiting.push(resolve));
  return true;
}

function releaseSlot(): void {
  const next = waiting.shift();
  // The slot passes straight to the next waiter, so `running` stays as it is.
  if (next) next();
  else running -= 1;
}

function sameToken(given: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(TOKEN);
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function runInChild(body: Uint8Array): Promise<ServerRunResponse> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--no-config",
      "--no-remote",
      "--no-npm",
      // PineTS reads this one switch. The child starts with an empty environment, so the
      // permission exposes nothing; every other variable, and all else, stays denied.
      `--allow-env=${PINETS_SWITCH}`,
      `--v8-flags=--max-old-space-size=${CHILD_HEAP_MB}`,
      CHILD,
    ],
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, RUN_TIMEOUT_MS);
  try {
    const writer = child.stdin.getWriter();
    await writer.write(body);
    await writer.close();
    const { code, stdout } = await child.output();
    if (timedOut) return { ok: false, error: { message: `Script exceeded ${RUN_TIMEOUT_MS / 1000}s` } };
    if (code !== 0) return { ok: false, error: { message: "The script crashed the runner" } };
    return JSON.parse(new TextDecoder().decode(stdout)) as ServerRunResponse;
  } catch {
    // A child killed mid-write or one that printed no JSON ends here.
    return { ok: false, error: { message: timedOut ? `Script exceeded ${RUN_TIMEOUT_MS / 1000}s` : "The script crashed the runner" } };
  } finally {
    clearTimeout(timer);
  }
}

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/health") return json({ ok: true, running, waiting: waiting.length });
  if (request.method !== "POST" || pathname !== "/run") return json({ error: "NOT_FOUND" }, 404);
  if (!sameToken(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) {
    return json({ error: "UNAUTHORIZED" }, 401);
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return json({ error: "TOO_LARGE" }, 413);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return json({ error: "TOO_LARGE" }, 413);

  if (!(await acquireSlot())) return json({ error: "BUSY" }, 503);
  try {
    return json(await runInChild(body));
  } finally {
    releaseSlot();
  }
}

Deno.serve({ hostname: HOST, port: PORT, onListen: () => console.log(`pine runner on ${HOST}:${PORT}`) }, handle);
