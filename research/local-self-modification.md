---
issue: TBD
last_updated: "2026-07-02"
status: proposed
---

# Local self-modification

## Summary

An agent running under `eve dev` should be able to read and modify its own source tree — its
instructions, tools, skills, and app code — so a developer can iterate on the agent by talking to
it. This is host filesystem access, so it is opt-in per agent and exists only in local development.
Production builds never contain this capability, regardless of configuration.

The author declares it as a subagent module, the way remote agents are declared. The capability
itself ships as a framework-owned **agent extension**: a subagent authored as files inside the eve
package, grafted into the compiled manifest and module map at compile time when the compile target
is development. Hosted compiles never graft it, so its modules are absent from production
artifacts entirely. There is no runtime-only assembly path: dev and prod runtimes load and resolve
their artifacts identically.

## Authoring API

One module under `agent/subagents/`, mirroring `defineRemoteAgent`. The definition is imported
from the extension's own package subpath, `eve/extensions/selfmod` — the main `eve` entry does not
export it:

```ts title="agent/subagents/selfmod.ts"
import { defineSelfModifyingAgent } from "eve/extensions/selfmod";

export default defineSelfModifyingAgent({
  development: true,
});
```

Each framework extension ships as one subpath export under `eve/extensions/<name>`, so the mount
surface scales per extension instead of accumulating define functions on the root entry. Only the
definition module is exported; the extension's agent files stay internal to the package and are
reached through compile-time logical paths, never app imports.

- The subagent's name derives from the file path — here the parent gains a `selfmod` tool. The
  standard subagent/tool namespace and collision rules apply unchanged.
- `development: true` is required (a literal type, not a default). The dev-only scoping is an
  explicit authored statement in the file, not hidden framework behavior; the live-tree sandbox
  cannot exist in a hosted deployment, so `development: false` or omission is a compile error.
- Optional fields configure the subagent like a declared subagent's `agent.ts`:

```ts title="agent/subagents/selfmod.ts"
export default defineSelfModifyingAgent({
  development: true,
  model: "anthropic/claude-sonnet-4.6",
  reasoning: { effort: "high" },
  instructions: "Keep every source edit minimal and scoped.",
});
```

- `model` / `reasoning` — defaults to the root agent's model config.
- `instructions` — appended to the extension's packaged instructions (which cover the live-tree
  scope, edit discipline, and the simulated-shell limits below).

Under `eve dev`, the parent gains one tool named after the file slug:

| Tool      | Does                                                               | Where it runs |
| --------- | ------------------------------------------------------------------ | ------------- |
| `selfmod` | Delegate a self-modification subtask to the project-tree subagent. | App runtime   |

It is lowered exactly like a declared subagent — same `{ message, outputSchema? }` input shape,
same `subagent.called` / `subagent.completed` control-plane events, same `maxSubagentDepth`
accounting — because after compilation it _is_ one. In a hosted compile the module lowers to
nothing: no node, no tool, no module-map entries.

## The extension, authored as files

The subagent's substance lives in the eve package as a normal agent directory; the authored
module above only mounts it:

```text
packages/eve/extensions/selfmod/
├── index.ts            # defineSelfModifyingAgent — the eve/extensions/selfmod export
├── agent.ts            # description + defaults; discovery-grammar compatible
├── instructions.md     # live-tree scope, edit discipline, shell limits
└── sandbox.ts          # just-bash backend mapped over the real project root
```

Discovery walks it with the same slot grammar as `agent/subagents/<id>/` — no bespoke
registration format. Everything the runtime needs (tools, sandbox, instructions) is expressed the
way an author would express it.

### Sandbox: just-bash over the real directory

The extension's `sandbox.ts` configures the just-bash backend with one change: its `ReadWriteFs`
root is the project root (the directory containing the agent's `package.json`), not a copy under
`.eve/sandbox-cache/`. Consequences:

- `/workspace` is the live project tree. Reads see current source; writes land directly on disk.
- No template, no prewarm copy, no capture/restore. Durability is the directory itself.
- Path containment and symlink gating come from `ReadWriteFs` (canonical-root validation on every
  operation), not from new eve code.
- The subagent carries the unchanged default harness tools (`bash`, `read_file`, `write_file`,
  `glob`, `grep`), so read-before-write and stale-read detection apply as in any sandbox.
- `bash` runs in just-bash's pure-JS interpreter: coreutils-style commands over the project tree,
  **no real binaries** (`git`, `node`, `pnpm`, `tsc`) and no host process execution. The packaged
  instructions state this; verification feedback comes from the dev watcher. Allowlisted real host
  commands are a possible follow-up, out of scope here.

The `just-bash` package follows its existing optional-dependency contract: absent from the app,
`eve dev` auto-installs it when a self-modifying subagent is declared.

The subagent gets no connections, no `agent` tool, and no nested subagents. Like every declared
subagent it starts each delegation with fresh history and state.

## Internal architecture: `AgentExtension` and `AgentArtifact`

The extension mechanism is internal (the public surface is only the `eve/extensions/selfmod`
subpath) but defined as a contract so future framework capabilities reuse it — each as its own
`eve/extensions/<name>` export — and the core consumes extensions through the same artifact types
it already consumes.

```text
compileAgent({ target })
|-- discover authored tree              -> AgentSourceManifest
|   `-- subagents/selfmod.ts            -> self-modifying definition (kind discriminator,
|                                          like remote agents' kind: "remote")
|-- lower extension mounts
|   `-- selfModifyingAgent producer(definition, target)
|       |-- target "hosted"       -> null (nothing grafted)
|       `-- target "development"  -> AgentArtifact
|           |-- discovery over packages/eve/extensions/selfmod/
|           `-- authored options merged over the packaged agent.ts defaults
|-- normalize + graft                   -> CompiledAgentManifest
|                                          (extension node = ordinary CompiledSubagentNode
|                                           named from the mounting file's slug)
`-- write artifacts                     -> .eve/ manifest + module map
                                           (module map imports extension modules
                                            only when the artifact was grafted)
```

- **`AgentArtifact`** is the grafting contract: a `CompiledSubagentNode` (embedding its
  `CompiledAgentNodeManifest`) plus the module-map entries its `ModuleSourceRef`s resolve through,
  and the parent edge. It introduces no new runtime types — `resolveRuntimeAgentGraph`, the
  subagent registry, depth capping, and name-collision guards consume the extension node with zero
  special-casing.
- **`AgentExtension`** is the producer signature: given the authored mount definition, the root
  agent's config, and the compile target, return an `AgentArtifact` or `null`.
  `eve/extensions/selfmod` is the first mount surface, and its producer is the first
  implementation.
- **Compile target** is the one new compiler input: `compileAgent` gains
  `target: "development" | "hosted"` (threaded from the existing `prepareApplicationHost`
  dev/build fork). Compile metadata and the runtime cache key include the target, so dev and
  hosted artifacts of the same source tree are distinct, correctly invalidated artifacts.
- Extension source lives outside the app root, so extension `ModuleSourceRef`s carry a
  package-namespaced logical path (e.g. `eve:extensions/selfmod/sandbox.ts`) and the
  module map emits absolute/package import specifiers for them — the generator already supports
  absolute specifier style.

## Semantics

### The self-modification loop

`eve dev` already watches authored source and recompiles on change. A `write_file` from the
subagent lands directly in the real tree, so it takes effect through the existing watcher: the
next parent turn runs the modified agent. No new reload machinery.

```text
parent turn N: model calls selfmod({ message: "add a `foo` tool that ..." })
`-- child session (sandbox = just-bash over project root)
    |-- read_file / grep to locate the change
    |-- write_file /workspace/agent/tools/foo.ts   (real file on disk)
    `-- returns a summary as the tool result
        `-- dev watcher recompiles the agent
            `-- parent turn N+1 runs with the new tool
```

The watcher's recompile also surfaces compile errors in the dev output, which is the v1 substitute
for the subagent running `tsc` itself.

### Local-only enforcement

Both layers live at build boundaries; the runtime has no dev/prod branch:

1. **Compile target gating:** hosted compiles lower the mount to nothing, so the compiled manifest
   carries no extension node and the module map imports none of its modules — the bundler has
   nothing to trace. `eve build` with a self-modifying subagent declared succeeds and logs that it
   is omitted from hosted targets.
2. **Hosted-build assertion:** the build output check fails the build if a development-target
   extension node or any `eve:extensions/*` module reference appears in hosted artifacts (guarded
   like other output invariants).

### Interaction with existing surfaces

- The mount occupies the shared tool/subagent namespace under its file-derived name. Collisions
  with authored tools or other subagents are compile errors via the existing rule — nothing new.
- The built-in `agent` tool inside the extension subagent is disabled. Copies would share the live
  tree with no write-scope separation while the watcher recompiles underneath them; one writer per
  delegation.
- The mount is root-only in v1: declaring it inside a declared subagent's `subagents/` directory
  is a compile error.
- The live-tree sandbox is distinct from the root agent's own sandbox. The root's `bash` and file
  tools keep operating on its normal `/workspace`; only the extension subagent sees the real
  directory.
- `.eve/` lives inside the project root and is visible to the subagent. The packaged instructions
  tell the model to leave it alone; it is not blocked in v1.
- The extension node appears in dev `.eve/` artifacts like any subagent, so `eve/v1/info`,
  inspection tooling, and the TUI see it without special handling.

## Security

Declaring the mount gives the model read/write access to the project tree on the developer's
machine, mediated by `ReadWriteFs` containment — it cannot reach outside the project root and
cannot execute host binaries, because the shell is the pure-JS interpreter over the same
filesystem wrapper. The trust boundary is the explicit authored mount (with its required
`development: true`) plus the compile-target guarantee, and the subagent boundary keeps even that
access out of the root model's direct tool surface: the parent can only delegate a described
subtask, and logs and approvals see one `selfmod` call per delegation. Docs must state plainly
that this modifies real project files and is unavailable in deployed agents by construction.

## Delivery and verification

- Unit: definition normalization (required literal `development: true`, model fallback to root,
  instructions merge), producer target gating (`null` for hosted), package-namespaced logical
  paths in the module map, name-collision and root-only rejection.
- Integration: compile with `target: "development"` grafts the extension node into the manifest
  and module map under the mount's slug; `target: "hosted"` yields artifacts identical to a
  compile without the mount; compile metadata and runtime cache keys diverge by target.
- Scenario: `eve dev` with the mount exposes the slug-named tool and the child session's
  `write_file` changes a real file that triggers recompilation; without the mount the tool is
  absent; a path escape attempt through the child's tools is rejected.
- Build assertion: hosted build output for an agent with the mount contains no extension node and
  no extension module reference (guarded like other output invariants).
- Docs: extend `docs/subagents.mdx` with the self-modifying mount and the security statement.
- Changeset: `patch`.
