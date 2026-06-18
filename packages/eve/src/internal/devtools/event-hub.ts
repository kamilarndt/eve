export interface DevToolsHubEvent {
  readonly data: unknown;
  readonly event: string;
  readonly id: string;
}

export interface DevToolsEventHub {
  readonly latestId: string;
  close(): void;
  publish(event: string, createData: (id: string) => unknown): string;
  replayAfter(lastEventId: string | undefined): {
    readonly events: readonly DevToolsHubEvent[];
    readonly stale: boolean;
  };
  subscribe(subscriber: (event: DevToolsHubEvent) => boolean): () => void;
}

export function createDevToolsEventHub(input: { readonly replayLimit: number }): DevToolsEventHub {
  const replay: DevToolsHubEvent[] = [];
  const subscribers = new Set<(event: DevToolsHubEvent) => boolean>();
  let closed = false;
  let cursor = 0;

  return {
    get latestId() {
      return String(cursor);
    },
    close() {
      closed = true;
      subscribers.clear();
      replay.length = 0;
    },
    publish(event, createData) {
      if (closed) {
        return String(cursor);
      }

      const id = String(++cursor);
      const entry: DevToolsHubEvent = { data: createData(id), event, id };
      replay.push(entry);
      if (replay.length > input.replayLimit) {
        replay.shift();
      }

      for (const subscriber of subscribers) {
        if (!subscriber(entry)) {
          subscribers.delete(subscriber);
        }
      }
      return id;
    },
    replayAfter(lastEventId) {
      const requested = parseCursor(lastEventId);
      const oldest = replay.length === 0 ? cursor + 1 : Number(replay[0]!.id);
      return {
        events: replay.filter((event) => Number(event.id) > requested),
        stale: requested > cursor || (requested > 0 && requested < oldest - 1),
      };
    },
    subscribe(subscriber) {
      if (closed) {
        return () => {};
      }
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}

export function parseCursor(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
