import { ChevronLeft } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";

interface ThreePaneLayoutProps {
  readonly details: ReactNode;
  readonly detailsLabel: string;
  readonly navigator: ReactNode;
  readonly navigatorLabel: string;
  readonly primary: ReactNode;
}

interface PaneNavigation {
  showPrimary(): void;
}

const PaneNavigationContext = createContext<PaneNavigation>({ showPrimary() {} });

export function usePaneNavigation(): PaneNavigation {
  return useContext(PaneNavigationContext);
}

export function ThreePaneLayout({
  details,
  detailsLabel,
  navigator,
  navigatorLabel,
  primary,
}: ThreePaneLayoutProps) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [navigatorWidth, setNavigatorWidth] = useState(240);
  const [detailsWidth, setDetailsWidth] = useState(340);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [compactPane, setCompactPane] = useState<"details" | "navigator" | "primary">("primary");

  const showPrimary = useCallback(() => {
    setCompactPane("primary");
    setDetailsOpen(false);
  }, []);
  const paneNavigation = useMemo(() => ({ showPrimary }), [showPrimary]);

  function beginResize(side: "details" | "navigator", event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const layout = layoutRef.current;
    if (layout === null) return;
    const startX = event.clientX;
    const initialWidth = side === "navigator" ? navigatorWidth : detailsWidth;

    function move(pointerEvent: globalThis.PointerEvent): void {
      const delta = pointerEvent.clientX - startX;
      if (side === "navigator") {
        setNavigatorWidth(clamp(initialWidth + delta, 200, 360));
      } else {
        setDetailsWidth(clamp(initialWidth - delta, 280, 520));
      }
    }

    function stop(): void {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.classList.remove("is-resizing");
    }

    document.body.classList.add("is-resizing");
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
  }

  return (
    <PaneNavigationContext.Provider value={paneNavigation}>
      <div
        className="three-pane-layout"
        data-compact-pane={compactPane}
        ref={layoutRef}
        style={
          {
            "--details-width": `${detailsWidth}px`,
            "--navigator-width": `${navigatorWidth}px`,
          } as CSSProperties
        }
      >
        <aside className="pane pane-navigator">{navigator}</aside>
        <div
          aria-label="Resize navigator"
          aria-orientation="vertical"
          className="pane-separator"
          onDoubleClick={() => setNavigatorWidth(240)}
          onPointerDown={(event) => beginResize("navigator", event)}
          role="separator"
          tabIndex={0}
        />
        <main className="pane pane-primary">
          <nav aria-label="Pane navigation" className="compact-pane-navigation">
            <button onClick={() => setCompactPane("navigator")} type="button">
              <ChevronLeft aria-hidden="true" size={13} />
              {navigatorLabel}
            </button>
          </nav>
          <button
            className="details-sheet-trigger"
            onClick={() => {
              setCompactPane("details");
              setDetailsOpen(true);
            }}
            type="button"
          >
            {detailsLabel}
          </button>
          {primary}
        </main>
        <div
          aria-label="Resize details"
          aria-orientation="vertical"
          className="pane-separator"
          onDoubleClick={() => setDetailsWidth(340)}
          onPointerDown={(event) => beginResize("details", event)}
          role="separator"
          tabIndex={0}
        />
        <aside className="pane pane-details" data-open={detailsOpen || undefined}>
          <button
            aria-label="Close details"
            className="details-sheet-close"
            onClick={showPrimary}
            type="button"
          >
            Back
          </button>
          {details}
        </aside>
        {detailsOpen && (
          <button
            aria-label="Close details"
            className="details-sheet-backdrop"
            onClick={showPrimary}
            type="button"
          />
        )}
      </div>
    </PaneNavigationContext.Provider>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
