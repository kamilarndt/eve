import type { DevToolsStreamEvent } from "@ui/controllers/live/live-types";

const reconnectDelayMs = 500;

export class DevToolsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DevToolsApiError";
    this.status = status;
  }
}

export class DevToolsApiClient {
  readonly #capability: string;
  readonly #origin: URL;

  constructor(capability: string, origin = window.location.origin) {
    this.#capability = capability;
    this.#origin = new URL(origin);
  }

  async get<T>(path: string): Promise<T> {
    return await this.request<T>(path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return await this.request<T>(path, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      method: "POST",
    });
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.#capability}`);
    const response = await fetch(new URL(path, this.#origin), { ...init, headers });
    if (!response.ok) {
      const message = await readErrorMessage(response);
      throw new DevToolsApiError(response.status, message);
    }
    return (await response.json()) as T;
  }

  async subscribe(input: {
    readonly onConnectionChange: (connected: boolean) => void;
    readonly onEvent: (event: DevToolsStreamEvent) => void;
    readonly signal: AbortSignal;
  }): Promise<void> {
    let lastEventId: string | undefined;
    while (!input.signal.aborted) {
      try {
        const headers = new Headers({
          accept: "text/event-stream",
          authorization: `Bearer ${this.#capability}`,
        });
        if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
        const response = await fetch(new URL("/api/v1/events", this.#origin), {
          headers,
          signal: input.signal,
        });
        if (!response.ok || response.body === null) {
          throw new DevToolsApiError(response.status, await readErrorMessage(response));
        }
        input.onConnectionChange(true);
        for await (const event of readEventStream(response.body, input.signal)) {
          lastEventId = event.id || lastEventId;
          input.onEvent(event);
        }
      } catch (error) {
        if (input.signal.aborted) return;
        if (error instanceof DevToolsApiError && error.status === 401) throw error;
        input.onConnectionChange(false);
        await delay(reconnectDelayMs, input.signal);
      }
    }
  }

  async debuggerUrl(): Promise<URL> {
    const response = await this.post<{ readonly ticket: string }>("/api/v1/debugger/tickets");
    const url = new URL(
      `/api/v1/debugger?ticket=${encodeURIComponent(response.ticket)}`,
      this.#origin,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }
}

async function* readEventStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<DevToolsStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = pending.indexOf("\n\n");
      while (boundary !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = parseEventBlock(block);
        if (event !== undefined) yield event;
        boundary = pending.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseEventBlock(block: string): DevToolsStreamEvent | undefined {
  let data = "";
  let event = "message";
  let id = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) data += `${line.slice(5).trimStart()}\n`;
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (data === "") return undefined;
  try {
    return { data: JSON.parse(data.trimEnd()) as unknown, event, id };
  } catch {
    return undefined;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { readonly error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // The status text is the safe fallback for non-JSON failures.
  }
  return response.statusText || `DevTools request failed with HTTP ${response.status}.`;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}
