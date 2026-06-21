import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CoordinatesStrip, findCoordinateEvent } from "@ui/components/coordinates-strip";
import { DevToolsControllerProvider } from "@ui/controllers/devtools-controller-context";
import { createTestController } from "@ui/controllers/fixture/test-controller.test-helper";
import type { Coordinates, TimelineEvent } from "@ui/model/devtools-model";

const coordinates: Coordinates = {
  action: "action-1",
  revision: "rev-1",
  session: "session-1",
  step: "2",
  turn: "turn-1",
};

describe("findCoordinateEvent", () => {
  it("selects the latest matching action, step, or turn event", () => {
    const events = [event("first"), event("latest"), event("other", { action: "action-2" })];

    expect(findCoordinateEvent(events, coordinates, "action")?.id).toBe("latest");
    expect(findCoordinateEvent(events, coordinates, "step")?.id).toBe("other");
    expect(findCoordinateEvent(events, coordinates, "turn")?.id).toBe("other");
  });

  it("falls back to session navigation when no matching event is retained", () => {
    expect(findCoordinateEvent([], coordinates, "action")).toBeUndefined();
    expect(findCoordinateEvent([event("event")], coordinates, "session")).toBeUndefined();
  });

  it("renders the complete session id", () => {
    const session = "session-1234567890-abcdefghijklmnopqrstuvwxyz";
    const html = renderToStaticMarkup(
      createElement(DevToolsControllerProvider, {
        children: createElement(CoordinatesStrip, {
          coordinates: { ...coordinates, session },
        }),
        controller: createTestController(),
      }),
    );

    expect(html).toContain(session);
  });
});

function event(id: string, override: Partial<Coordinates> = {}): TimelineEvent {
  return {
    coordinates: { ...coordinates, ...override },
    id,
    kind: "action",
    label: "Action",
    raw: {},
    sessionId: "session-1",
    status: "completed",
    summary: "Action",
    time: "10:00:00",
  };
}
