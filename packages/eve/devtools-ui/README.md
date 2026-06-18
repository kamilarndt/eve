# Eve DevTools UI

This directory is the final source home for the browser DevTools frontend. It is built as static assets inside the published `eve` package and is not a separately published package.

## Development

Run the fixture-backed visual prototype:

```bash
pnpm --filter eve dev:devtools-ui
```

The Vite development server uses the fixture controller and stores `panel`, `scenario`, and `theme` in the URL. Available scenarios are `empty`, `running`, `paused`, `crashed`, and `stress`.

Build the production assets:

```bash
pnpm --filter eve build:devtools-ui
```

The build writes hashed assets and a Vite manifest to `packages/eve/dist/devtools-ui/`. React, Geist, Lucide, and future source-view dependencies are bundled into those assets and do not become `eve` runtime dependencies.

## Architecture

Panels and components consume `DevToolsController`, not HTTP, SSE, CDP, or fixture records directly.

```text
fixture controller ---+
                      +--> DevToolsController --> app, panels, components
backend controller ---+
```

The fixture controller is the isolated visual-development adapter. The live controller reads the capability from the URL fragment and composes `/api/v1` JSON endpoints, authenticated fetch-based SSE, and the ticketed debugger WebSocket without changing panel component ownership.

The browser-safe UI model is intentionally separate from transport payloads. The backend controller owns normalization into stable run, event, definition, source, log, and debugger entities.
