// SPDX-License-Identifier: AGPL-3.0-only
// Runs one Pine script per run request. The host terminates this worker on timeout.
import { Indicator, PineTS } from "pinets";
import { upgradeLegacyPine } from "./legacy";
import {
  isDataResponse,
  isRunRequest,
  type DataRequest,
  type DataResponse,
  type RunReply,
  type RunRequest,
  type RunnerCandles,
} from "./protocol";
import { createProvider, type FetchCandles } from "./provider";
import { applyInputs, serializeContext, toRunError } from "./serialize";

const MAX_LOOPS = 200_000;

type Settle = (response: DataResponse) => void;
const pendingData = new Map<string, Settle>();
let dataSequence = 0;

function hostFetcher(runId: string): FetchCandles {
  return (query) =>
    new Promise<RunnerCandles>((resolve, reject) => {
      const requestId = `data-${(dataSequence += 1)}`;
      pendingData.set(requestId, (response) => {
        if (response.ok && response.candles) resolve(response.candles);
        else reject(new Error(`request.security: ${response.error ?? "no data"} (${query.symbol}, ${query.timeframe})`));
      });
      const message: DataRequest = { type: "pine-runner:data-request", runId, requestId, ...query };
      self.postMessage(message);
    });
}

async function run(request: RunRequest): Promise<RunReply> {
  const started = performance.now();
  const upgrade = upgradeLegacyPine(request.source);
  const data = createProvider(request, hostFetcher(request.id));
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

self.onmessage = (event: MessageEvent<unknown>) => {
  if (isDataResponse(event.data)) {
    pendingData.get(event.data.requestId)?.(event.data);
    pendingData.delete(event.data.requestId);
    return;
  }
  if (isRunRequest(event.data)) {
    void run(event.data).then((reply) => self.postMessage(reply));
  }
};
