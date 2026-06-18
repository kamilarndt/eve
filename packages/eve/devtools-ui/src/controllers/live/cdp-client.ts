import { DevToolsApiClient } from "@ui/controllers/live/api-client";

interface CdpMessage {
  readonly error?: { readonly message?: string };
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

export class CdpClient {
  readonly #listeners = new Set<(method: string, params: unknown) => void>();
  readonly #pending = new Map<
    number,
    { readonly reject: (error: Error) => void; readonly resolve: (value: unknown) => void }
  >();
  readonly #socket: WebSocket;
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#handleMessage(String(event.data)));
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Debugger connection closed."));
      }
      this.#pending.clear();
    });
  }

  static async connect(api: DevToolsApiClient): Promise<CdpClient> {
    const socket = new WebSocket(await api.debuggerUrl());
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Debugger connection failed.")), {
        once: true,
      });
    });
    const client = new CdpClient(socket);
    await client.command("Runtime.enable");
    await client.command("Debugger.enable");
    return client;
  }

  close(): void {
    this.#socket.close();
  }

  async command<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("Debugger is not connected.");
    }
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return (await result) as T;
  }

  onEvent(listener: (method: string, params: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #handleMessage(serialized: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(serialized) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending?.reject(new Error(message.error.message ?? "Debugger command failed."));
      } else {
        pending?.resolve(message.result);
      }
      return;
    }
    if (message.method === undefined) return;
    for (const listener of this.#listeners) listener(message.method, message.params);
  }
}
