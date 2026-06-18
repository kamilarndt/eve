import type { Coordinates } from "@ui/model/devtools-model";
import { formatRevision } from "@ui/components/revision";
import { useDevToolsController } from "@ui/controllers/devtools-controller-context";
import type { TimelineEvent } from "@ui/model/devtools-model";

interface CoordinatesStripProps {
  readonly coordinates: Coordinates;
}

export function CoordinatesStrip({ coordinates }: CoordinatesStripProps) {
  const controller = useDevToolsController();
  const segments = [
    ["session", shortId(coordinates.session)],
    ["turn", coordinates.turn],
    ["step", coordinates.step],
    ["action", coordinates.action],
    ["rev", formatRevision(coordinates.revision)],
  ].filter((segment): segment is [string, string] => segment[1] !== undefined);

  function navigate(label: string): void {
    if (label === "rev") return;
    controller.selectRun(coordinates.session);
    const event = findCoordinateEvent(controller.events, coordinates, label);
    if (event !== undefined) controller.selectEvent(event.id);
    controller.selectPanel("runs");
  }

  return (
    <div aria-label="Execution coordinates" className="coordinates-strip">
      {segments.map(([label, value]) =>
        label === "rev" ? (
          <span className="coordinate-static" key={label} title={coordinates.revision}>
            <span>{label}</span> {value}
          </span>
        ) : (
          <button key={label} onClick={() => navigate(label)} type="button">
            <span>{label}</span> {value}
          </button>
        ),
      )}
    </div>
  );
}

export function findCoordinateEvent(
  events: readonly TimelineEvent[],
  coordinates: Coordinates,
  label: string,
): TimelineEvent | undefined {
  if (label === "session") return undefined;
  return events.findLast((event) => {
    if (event.sessionId !== coordinates.session) return false;
    if (label === "action") return event.coordinates.action === coordinates.action;
    if (label === "step") {
      return (
        event.coordinates.turn === coordinates.turn && event.coordinates.step === coordinates.step
      );
    }
    return label === "turn" && event.coordinates.turn === coordinates.turn;
  });
}

function shortId(value: string): string {
  return value.length > 14 ? value.slice(0, 14) : value;
}
