// SPDX-License-Identifier: AGPL-3.0-only
// One Pine run, shared by the browser worker and the server child process.
import { Indicator, PineTS } from "pinets";
import { upgradeLegacyPine } from "./legacy";
import type { RunReply, RunRequest } from "./protocol";
import { createProvider, type FetchCandles } from "./provider";
import { applyInputs, serializeContext, toRunError } from "./serialize";

const MAX_LOOPS = 200_000;

/** Runs the script on the request's candles. Other series come from `fetchCandles`. */
export async function runPine(request: RunRequest, fetchCandles: FetchCandles): Promise<RunReply> {
  const started = performance.now();
  const upgrade = upgradeLegacyPine(request.source);
  const data = createProvider(request, fetchCandles);
  try {
    const indicator = new Indicator(upgrade.source);
    const inputWarnings = applyInputs(indicator, request.inputs);
    const pine = new PineTS(data.provider, request.symbol ?? "UNKNOWN", request.timeframe);
    pine.setMaxLoops(MAX_LOOPS);
    const ctx = await pine.run(indicator);
    if (data.failures[0]) throw new Error(data.failures[0]);
    return {
      type: "pine-runner:result",
      id: request.id,
      ok: true,
      result: serializeContext(ctx, indicator, {
        durationMs: performance.now() - started,
        upgradedFromVersion: upgrade.fromVersion,
        inputWarnings,
      }),
    };
  } catch (error) {
    return {
      type: "pine-runner:result",
      id: request.id,
      ok: false,
      // A missing series usually breaks the script later; the data failure is the real cause.
      error: toRunError(data.failures[0] ?? error, upgrade.lineOffset),
    };
  }
}
