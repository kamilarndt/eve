---
issue: TBD
last_updated: "2026-07-02"
status: proposed
---

# Local self-modification

## Summary

Let an agent running under `eve dev` read and modify its own source tree, so a developer can
iterate on the agent by talking to it. The author declares a subagent module, the way remote
agents are declared. The capability itself is a framework-owned subagent authored as files inside
the eve package, grafted into the compiled manifest and module map only when the compile target is
development. Hosted artifacts never contain it, and dev and prod runtimes load artifacts
identically — there is no runtime-only assembly path.

## Authoring API

One module under `agent/subagents/`, mirroring `defineRemoteAgent`. The definition is imported
from the extension's own package subpath — the main `eve` entry does not export it:

```ts title="agent/subagents/selfmod.ts"
import { defineSelfModifyingAgent } from "eve/extensions/selfmod";

export default defineSelfModifyingAgent({
  development: true, // required literal; omission is a compile error
  model: "anthropic/claude-sonnet-4.6", // optional; defaults to the root agent's model
  reasoning: { effort: "high" }, // optional
  instructions: "Keep edits minimal.", // optional; appended to the packaged instructions
});
```

Each framework extension ships as one subpath export under `eve/extensions/<name>`, so the mount
surface scales per extension instead of accumulating define functions on the root entry.

The tool name derives from the file slug (here `selfmod`), with the standard subagent namespace
and collision rules. It lowers exactly like a declared subagent — `{ message, outputSchema? }`
input, `subagent.called` / `subagent.completed` events, `maxSubagentDepth` accounting — because
after compilation it is one. In a hosted compile the module lowers to nothing: no node, no tool,
no module-map entries.

## The extension, authored as files

The mount refers to a normal agent directory shipped in the eve package. Only the definition
module is exported; the agent files stay internal, reached through compile-time logical paths,
never app imports:

```text
packages/eve/extensions/selfmod/
├── index.ts            # defineSelfModifyingAgent — the eve/extensions/selfmod export
├── agent.ts            # description + defaults
├── instructions.md     # live-tree scope, edit discipline, shell limits
└── sandbox.ts          # just-bash backend over the real project root
```

Discovery walks it with the same slot grammar as `agent/subagents/<id>/`. The subagent carries the
unchanged default harness tools (`bash`, `read_file`, `write_file`, `glob`, `grep`) and gets no
connections, no `agent` tool, and no nested subagents.

Its sandbox is the just-bash backend with one change: the `ReadWriteFs` root is the project root,
not a copy under `.eve/sandbox-cache/`. So:

- `/workspace` is the live project tree; writes land directly on disk. No template, no prewarm
  copy, no capture/restore.
- Path containment and symlink gating come from `ReadWriteFs`, and harness read-before-write
  applies as in any sandbox.
- `bash` is just-bash's pure-JS interpreter: coreutils over the project tree, no real binaries
  (`git`, `pnpm`, `tsc`), no host process execution. Allowlisted host commands are a possible
  follow-up.
- `just-bash` keeps its optional-dependency contract: `eve dev` auto-installs it when the mount is
  declared.

## Compile-time grafting

```text
compileAgent({ target })
|-- subagents/selfmod.ts       -> self-modifying definition (kind-discriminated, like remote agents)
|-- lower the mount
|   |-- target "hosted"        -> nothing
|   `-- target "development"   -> ordinary CompiledSubagentNode + module-map entries + parent edge,
|                                 from discovery over packages/eve/extensions/selfmod/,
|                                 authored options merged over its defaults
`-- write .eve/ artifacts
```

The lowering step is the internal `AgentExtension` contract — packaged agent files in, an
ordinary compiled subagent node out — reusable by future framework capabilities, each as its own
`eve/extensions/<name>` export. Runtime graph resolution, the subagent registry, depth capping,
and collision guards consume the grafted node with zero special-casing. Two supporting changes:

- `compileAgent` gains `target: "development" | "hosted"`, threaded from the existing
  `prepareApplicationHost` dev/build fork and included in compile metadata and runtime cache keys.
- Extension modules live outside the app root, so their `ModuleSourceRef`s use a
  package-namespaced logical path (`eve:extensions/selfmod/...`) and the module map emits absolute
  import specifiers for them (already supported).

## Semantics

Self-edits flow through the existing dev watcher — no new reload machinery:

```text
parent turn N: selfmod({ message: "add a `foo` tool that ..." })
`-- child session (sandbox = just-bash over project root)
    |-- read_file / grep, then write_file /workspace/agent/tools/foo.ts
    `-- returns a summary
        `-- dev watcher recompiles -> parent turn N+1 runs with the new tool
```

The watcher's recompile surfaces compile errors in dev output, standing in for the subagent
running `tsc` itself.

Local-only enforcement, both at build boundaries:

1. Hosted compiles lower the mount to nothing, so the bundler has nothing to trace. `eve build`
   logs that the mount is omitted.
2. The hosted output check fails the build if an extension node or any `eve:extensions/*` module
   reference appears (guarded like other output invariants).

Boundaries:

- Root-only in v1: declaring the mount inside a declared subagent is a compile error.
- The built-in `agent` tool inside the subagent is disabled — one writer per delegation, since
  copies would share the live tree while the watcher recompiles underneath them.
- Only the extension subagent sees the real directory; the root agent's own sandbox is unchanged.
- `.eve/` is visible to the subagent; the packaged instructions say to leave it alone (not blocked
  in v1).

## Security

The mount gives the model read/write access to the project tree on the developer's machine,
contained by `ReadWriteFs` — it cannot reach outside the project root and cannot execute host
binaries. The trust boundary is the explicit authored mount (`development: true`) plus the
compile-target guarantee; the parent only delegates described subtasks, so approvals and logs see
one `selfmod` call per delegation. Docs must state plainly that this modifies real project files
and is unavailable in deployed agents by construction.

## Delivery and verification

Unit tests cover definition normalization and target gating; an integration test asserts a hosted
compile with the mount yields artifacts identical to one without it; a scenario covers `eve dev`
exposing the tool, a real write triggering recompilation, and path-escape rejection; the hosted
output invariant guards against extension references. Document the mount in `docs/subagents.mdx`.
Changeset: `patch`.
