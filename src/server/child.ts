// SPDX-License-Identifier: AGPL-3.0-only
// One Pine run in its own Deno process. The server starts it with no permission at all: no
// network, no file system, no environment and no subprocess. It reads the request from stdin
// and writes the response to stdout.
import { isServerRunRequest, type ServerRunResponse } from "./contract";
import { executeServerRun } from "./execute";

async function respond(): Promise<ServerRunResponse> {
  const request: unknown = JSON.parse(await new Response(Deno.stdin.readable).text());
  if (!isServerRunRequest(request)) return { ok: false, error: { message: "Invalid run request" } };
  return executeServerRun(request);
}

const response = await respond().catch(
  (error: unknown): ServerRunResponse => ({
    ok: false,
    error: { message: error instanceof Error ? error.message : String(error) },
  }),
);
await Deno.stdout.write(new TextEncoder().encode(JSON.stringify(response)));
Deno.exit(0);
