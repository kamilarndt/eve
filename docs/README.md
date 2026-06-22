# eve documentation

These Markdown files are the canonical eve docs. They render at `eve.dev/docs` and ship with the
npm package at `node_modules/eve/docs`, so you can rely on the same paths and examples from a
browser or an installed package. Coding agents do not need network access to use them.

Start with [Quickstart](./quickstart.mdx). For a complete application, continue through
[Build an Agent](./tutorial/first-agent.mdx).

## Task index

- Understand the framework: [Introducing eve](./index.mdx)
- Find an authored file or directory: [Project Structure](./build/project-structure.md)
- Configure a model: [Models and Providers](./build/models-and-providers.mdx)
- Add executable behavior: [Tools](./build/tools.mdx)
- Add an MCP or OpenAPI service: [Connections](./connect/connections/index.mdx)
- Add a messaging surface: [Channels](./connect/channels/index.mdx)
- Call an agent from code: [TypeScript Client](./connect/typescript-client/index.mdx)
- Deploy: [Deployment](./operate/deployment/index.md)
- Diagnose a problem: [Troubleshooting](./operate/troubleshooting.md)

## Exact reference

- [CLI](./reference/cli.md)
- [TypeScript API](./reference/typescript-api.md)
- [HTTP API](./reference/http-api.md)
- [Stream Events](./reference/stream-events.md)
- [Environment and Compatibility](./reference/environment-and-compatibility.md)
- [Glossary](./reference/glossary.md)

When implementing an eve project, treat file paths, import specifiers, schemas, defaults, and
failure behavior in these docs as technical contracts. Run `eve info --json`, the project
typecheck, and an actual session before reporting success.

Documentation contributors should read [STYLE.md](./STYLE.md) and run `pnpm docs:check` from the
eve repository root.
