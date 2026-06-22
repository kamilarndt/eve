# eve

eve is a filesystem-first framework for durable backend AI agents. Instructions, tools, skills, connections, channels, schedules, sandboxes, hooks, and subagents live in conventional files; eve discovers, compiles, and runs the resulting application.

The package includes the `eve` CLI, runtime, client libraries, framework integrations, and the complete raw documentation tree.

## Requirements

- Node.js 24 or newer.
- npm, pnpm, or another Node package manager.
- A model credential: Vercel project OIDC, `AI_GATEWAY_API_KEY`, or a direct AI SDK provider package and provider key.

## Create an application

Run from the directory that should contain the project:

```bash
npx eve@latest init my-agent
cd my-agent
```

The generated application uses a directory like this:

```text
agent/
├── agent.ts
├── instructions.md
├── channels/
├── connections/
├── hooks/
├── sandbox/
├── schedules/
├── skills/
├── subagents/
└── tools/
```

Identity is derived from file paths. For example, `agent/tools/get_weather.ts` registers the tool `get_weather`; tool slugs match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`.

## Minimal tool

```ts title="agent/tools/get_weather.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Return mock weather data for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
```

Run from the application root:

```bash
npx eve info --json
npx eve dev
```

`eve dev` defaults to port `2000` and prints the actual URL. Use `npx eve dev --no-ui` for a headless development server.

## Documentation in the package

The npm tarball contains `node_modules/eve/docs/`. This is a supported documentation interface for coding agents and offline use, not an incidental website copy.

Start with:

- [Package docs index](./docs/README.md)
- [Quickstart](./docs/quickstart.mdx)
- [Project Structure](./docs/build/project-structure.md)
- [Tools](./docs/build/tools.mdx)
- [TypeScript API](./docs/reference/typescript-api.md)
- [HTTP API](./docs/reference/http-api.md)
- [Troubleshooting](./docs/operate/troubleshooting.md)

The same pages render at [eve.dev/docs](https://eve.dev/docs). Relative links inside the Markdown work in a checkout and in the installed package.

## Runtime boundaries

- Authored tool functions execute in the trusted eve server process.
- Model-controlled shell and file operations proxy into an isolated `/workspace` sandbox.
- Route authentication decides who may create, continue, or stream a session.
- Connection authentication resolves outbound credentials without placing tokens in model history.
- Durable public conversations are identified by `sessionId`; clients also persist the current `continuationToken` and stream index.

One user turn may require multiple model calls for tool results, subagents, retries, or compaction. External side effects must be idempotent because an interrupted durable step can run again.

## Deployment

Vercel is the managed path for Workflow, Sandbox, Cron integration, and hosted build output. eve also builds a Nitro Node service for self-hosting, where the operator must provide persistent workflow storage, sandbox capacity, scheduling, TLS, scaling, and observability.

Read [Deployment](./docs/operate/deployment/index.md), [Deploy on Vercel](./docs/operate/deployment/vercel.md), or [Self-host eve](./docs/operate/deployment/self-hosting.md).

## Upgrades

eve is pre-1.0 and may make intentional breaking changes. Review [CHANGELOG.md](./CHANGELOG.md) and the [upgrade guide](./docs/operate/upgrading.md) before changing versions.
