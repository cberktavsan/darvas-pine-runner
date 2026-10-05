// SPDX-License-Identifier: AGPL-3.0-only
// Runs one Pine script per run request. The host terminates this worker on timeout.
import {
  isDataResponse,
  isRunRequest,
  type DataRequest,
  type DataResponse,
  type RunnerCandles,
} from "./protocol";
import type { FetchCandles } from "./provider";
import { runPine } from "./run";

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

self.onmessage = (event: MessageEvent<unknown>) => {
  if (isDataResponse(event.data)) {
    pendingData.get(event.data.requestId)?.(event.data);
    pendingData.delete(event.data.requestId);
    return;
  }
  if (isRunRequest(event.data)) {
    void runPine(event.data, hostFetcher(event.data.id)).then((reply) => self.postMessage(reply));
  }
};
