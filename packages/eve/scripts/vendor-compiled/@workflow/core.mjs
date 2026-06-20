import { relative } from "node:path";

import {
  buildUniqueSymbolStub,
  collectFilesRecursively,
  createDeclarationCopier,
} from "../_shared.mjs";

const WORKFLOW_GET_PORT_LAZY_SUFFIX = "/@workflow/core/dist/runtime/get-port-lazy.js";

function createWorkflowGetPortPlugin() {
  let replacedGetPortLazy = false;

  return {
    name: "eve-workflow-get-port",
    buildStart() {
      replacedGetPortLazy = false;
    },
    load(id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (!normalizedId.endsWith(WORKFLOW_GET_PORT_LAZY_SUFFIX)) {
        return undefined;
      }

      replacedGetPortLazy = true;
      return {
        code: `import { getPort } from "@workflow/utils/get-port";

function readConfiguredPort() {
  const value = process.env.PORT?.trim();
  if (!value) return undefined;

  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

export async function getPortLazy() {
  return readConfiguredPort() ?? await getPort();
}
`,
        moduleType: "js",
      };
    },
    buildEnd() {
      if (!replacedGetPortLazy) {
        throw new Error(
          `Expected to replace ${WORKFLOW_GET_PORT_LAZY_SUFFIX} while vendoring @workflow/core.`,
        );
      }
    },
  };
}

async function discoverDeclarationFiles({ distDir }) {
  const files = await collectFilesRecursively(distDir, [".d.ts"]);
  return (
    files
      .map((file) => relative(distDir, file).replaceAll("\\", "/"))
      // eve flattens dist/workflow/index.js to workflow.js, so workflow.d.ts
      // is owned by the shim entry below instead of upstream's VM-runner file.
      .filter((file) => file !== "workflow.d.ts")
      .sort()
      .map((file) => ({ source: file, output: file }))
  );
}

function buildMsStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@workflow/core.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (name === "StringValue") {
      lines.push(`export type StringValue = string;`);
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildWorkflowUtilsStub(names, moduleName) {
  const lines = [
    `// Auto-generated stub for \`${moduleName}\` types referenced by a vendored .d.ts.`,
    `// Emitted by scripts/vendor-compiled/@workflow/core.mjs.`,
    ``,
  ];
  for (const name of [...names].sort()) {
    if (name === "PromiseWithResolvers") {
      lines.push(
        `export interface PromiseWithResolvers<T = unknown> {`,
        `  promise: Promise<T>;`,
        `  resolve(value: T | PromiseLike<T>): void;`,
        `  reject(reason?: unknown): void;`,
        `}`,
      );
    } else {
      lines.push(`export type ${name} = unknown;`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const copyDeclarations = createDeclarationCopier({
  files: discoverDeclarationFiles,
  rewrites: {
    "@opentelemetry/api": {
      kind: "vendored",
      compiledPath: "@opentelemetry/api",
    },
    "@standard-schema/spec": {
      kind: "vendored",
      compiledPath: "@standard-schema/spec",
    },
    "@workflow/errors": {
      kind: "vendored",
      compiledPath: "@workflow/errors",
    },
    "@workflow/serde": {
      kind: "stub",
      stubBaseName: "_workflow-serde",
      build: buildUniqueSymbolStub,
    },
    "@workflow/utils": {
      kind: "stub",
      stubBaseName: "_workflow-utils",
      build: buildWorkflowUtilsStub,
    },
    "@workflow/world": {
      kind: "vendored",
      compiledPath: "@workflow/world",
    },
    ms: {
      kind: "stub",
      stubBaseName: "_ms",
      build: buildMsStub,
    },
  },
});

export default {
  packageName: "@workflow/core",
  compiledPath: "@workflow/core",
  chunkGroup: "workflow",
  entries: [
    {
      outputPath: "index",
    },
    {
      entry: "dist/workflow/index.js",
      outputPath: "workflow",
      declaration: `export * from "./workflow/index.js";\n`,
    },
    {
      input: "@workflow/core/runtime",
      outputPath: "runtime",
    },
    {
      entry: "dist/private.js",
      outputPath: "private",
    },
  ],
  plugins: [createWorkflowGetPortPlugin()],
  copyDeclarations,
};
