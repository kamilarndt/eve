import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const DEVTOOLS_HOST = "127.0.0.1";

export interface DevToolsServerHandle {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startDevToolsServer(input: {
  readonly handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    port: number,
  ) => Promise<void>;
  readonly handleUpgrade: (req: IncomingMessage, socket: Duplex, port: number) => void;
}): Promise<DevToolsServerHandle> {
  let port = 0;
  const server = createServer((req, res) => {
    void input.handleRequest(req, res, port).catch((error) => {
      res.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.on("upgrade", (req, socket) => {
    input.handleUpgrade(req, socket, port);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEVTOOLS_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer();
    throw new Error("DevTools host did not expose a TCP address.");
  }
  port = address.port;

  async function closeServer(): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    close: closeServer,
    port,
    url: `http://${DEVTOOLS_HOST}:${port}/`,
  };
}
