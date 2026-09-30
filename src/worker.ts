// SPDX-License-Identifier: AGPL-3.0-only
// Runs one Pine script per message. The host terminates this worker on timeout.
import { Indicator, PineTS } from "pinets";
import type { RunReply, RunRequest } from "./protocol";
import { serializeContext, toPineTsCandles, toRunError } from "./serialize";

const MAX_LOOPS = 200_000;

async function run(request: RunRequest): Promise<RunReply> {
  const started = performance.now();
  try {
    const indicator = new Indicator(request.source);
    for (const [key, value] of Object.entries(request.inputs ?? {})) {
      indicator.input[key] = value;
    }
    const pine = new PineTS(
      toPineTsCandles(request.candles, request.timeframe),
      request.symbol ?? "UNKNOWN",
      request.timeframe,
    );
    pine.setMaxLoops(MAX_LOOPS);
    const ctx = await pine.run(indicator);
    return {
      type: "pine-runner:result",
      id: request.id,
      ok: true,
      result: serializeContext(ctx, indicator, performance.now() - started),
    };
  } catch (error) {
    return { type: "pine-runner:result", id: request.id, ok: false, error: toRunError(error) };
  }
}

self.onmessage = (event: MessageEvent<RunRequest>) => {
  void run(event.data).then((reply) => self.postMessage(reply));
};
