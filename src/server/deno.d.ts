// SPDX-License-Identifier: AGPL-3.0-only
// The small part of the Deno runtime the server runner uses.
declare namespace Deno {
  const stdin: { readable: ReadableStream<Uint8Array> };
  const stdout: { write(data: Uint8Array): Promise<number> };
  const env: { get(name: string): string | undefined };
  function execPath(): string;
  function exit(code: number): never;
  function serve(
    options: { hostname: string; port: number; onListen?: () => void },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;

  interface ChildProcess {
    stdin: WritableStream<Uint8Array>;
    kill(signal: "SIGKILL"): void;
    output(): Promise<{ code: number; stdout: Uint8Array }>;
  }
  class Command {
    constructor(
      command: string,
      options: {
        args: string[];
        clearEnv: boolean;
        stdin: "piped";
        stdout: "piped";
        stderr: "null";
      },
    );
    spawn(): ChildProcess;
  }
}
