#!/usr/bin/env node
/**
 * CI lint that validates the `eve` import paths used in documentation code
 * samples against the package's real `exports` map.
 *
 * Docs are the most-copied surface of the framework, and the cheapest way for
 * a sample to rot is to import from a subpath that no longer exists (or never
 * did). Full type-checking of every snippet is noisy because many blocks are
 * intentional fragments; validating import specifiers against the exports map
 * is deterministic and catches the highest-frequency failure with no false
 * positives.
 *
 * Checks every ```ts / ```typescript fenced block under /docs: any
 * `from "eve..."` / `import("eve...")` specifier must resolve to a real
 * subpath in packages/eve/package.json#exports.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = `${repoRoot}/docs`;
const pkg = JSON.parse(readFileSync(`${repoRoot}/packages/eve/package.json`, "utf8"));
const hostPeerPackages = new Set(Object.keys(pkg.peerDependencies ?? {}));

// Build the set of valid bare import specifiers from the exports map:
//   "."            -> "eve"
//   "./tools"      -> "eve/tools"
//   "./channels/x" -> "eve/channels/x"
const validSpecifiers = new Set();
for (const key of Object.keys(pkg.exports ?? {})) {
  if (key === "./package.json") continue;
  validSpecifiers.add(key === "." ? "eve" : `eve/${key.slice(2)}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".md") || entry.endsWith(".mdx")) out.push(full);
  }
  return out;
}

const fenceRe = /```(ts|tsx|typescript)\b([^\n]*)\n([\s\S]*?)```/g;
// Capture the module specifier from static and dynamic imports/exports.
const specRe = /(?:from|import|export\s+\*\s+from)\s*\(?\s*["']([^"']+)["']/g;

const failures = [];
let blockCount = 0;
let specCount = 0;
const checkedBlocks = [];

for (const abs of walk(docsDir)) {
  const rel = relative(docsDir, abs);
  const source = readFileSync(abs, "utf8");
  let block;
  while ((block = fenceRe.exec(source)) !== null) {
    blockCount += 1;
    const meta = block[2].trim();
    const code = block[3];
    if (/(^|\s)check(?:\s|$)/.test(meta)) {
      const title = /\btitle=["']([^"']+)["']/.exec(meta)?.[1];
      if (!title) {
        failures.push({
          file: rel,
          detail: 'a `check` TypeScript fence requires title="path/to/file.ts"',
        });
      } else if (!/\.(?:ts|tsx)$/.test(title)) {
        failures.push({
          file: rel,
          detail: `checked example title \`${title}\` must end in .ts or .tsx`,
        });
      } else {
        checkedBlocks.push({ code, file: rel, source, title });
      }
    }
    let m;
    while ((m = specRe.exec(code)) !== null) {
      const spec = m[1];
      if (spec !== "eve" && !spec.startsWith("eve/")) continue; // only validate eve imports
      specCount += 1;
      if (!validSpecifiers.has(spec)) {
        failures.push({ file: rel, spec });
      }
    }

    if (/(^|\s)check(?:\s|$)/.test(meta)) {
      const packageImports = [...code.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((entry) => entry[1])
        .filter(
          (specifier) =>
            !specifier.startsWith(".") &&
            !specifier.startsWith("node:") &&
            specifier !== "eve" &&
            !specifier.startsWith("eve/") &&
            specifier !== "zod" &&
            !hostPeerPackages.has(
              specifier.startsWith("@")
                ? specifier.split("/").slice(0, 2).join("/")
                : specifier.split("/")[0],
            ),
        );
      for (const specifier of packageImports) {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const install = new RegExp(
          `(?:npm\\s+(?:install|i)|pnpm\\s+add|yarn\\s+add|bun\\s+add)[^\\n]*${escaped}`,
        );
        if (!install.test(source)) {
          failures.push({
            file: rel,
            detail: `checked example imports \`${packageName}\` but the page has no package installation command`,
          });
        }
      }
    }
  }
}

if (checkedBlocks.length === 0) {
  failures.push({
    file: "(corpus)",
    detail: "no opt-in TypeScript examples use the `check` fence marker",
  });
}

// Full compilation is opt-in because it requires a freshly built eve package.
// Run `pnpm build && pnpm docs:check:examples` in release or docs-audit work.
if (process.argv.includes("--compile") && failures.length === 0) {
  const packageRoot = `${repoRoot}/packages/eve`;
  if (!statSync(`${packageRoot}/dist`, { throwIfNoEntry: false })?.isDirectory()) {
    failures.push({
      file: "(compile)",
      detail: "packages/eve/dist is missing; run `pnpm build` before `pnpm docs:check:examples`",
    });
  } else {
    const tempDir = mkdtempSync(`${packageRoot}/.docs-examples-`);
    try {
      for (const [index, example] of checkedBlocks.entries()) {
        const extension = example.title.endsWith(".tsx") ? "tsx" : "ts";
        const path = `${tempDir}/example-${index}.${extension}`;
        writeFileSync(path, example.code);
        const result = spawnSync(
          `${repoRoot}/node_modules/.bin/tsc`,
          [
            "--noEmit",
            "--ignoreConfig",
            "--skipLibCheck",
            "--module",
            "NodeNext",
            "--moduleResolution",
            "NodeNext",
            "--target",
            "ES2022",
            "--types",
            "node",
            "--jsx",
            "react-jsx",
            path,
          ],
          { cwd: packageRoot, encoding: "utf8" },
        );
        if (result.status !== 0) {
          failures.push({
            file: example.file,
            detail: `checked example \`${example.title}\` does not compile:\n${(result.stdout || result.stderr).trim()}`,
          });
        }
      }
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  }
}

if (failures.length === 0) {
  process.stdout.write(
    `[docs:snippets] ok — ${specCount} eve imports resolve across ${blockCount} TypeScript blocks; ${checkedBlocks.length} opt-in examples validated${process.argv.includes("--compile") ? " and compiled" : ""}.\n`,
  );
  process.exit(0);
}

process.stderr.write("[docs:snippets] FAIL\n\n");
for (const { file, spec, detail } of failures) {
  process.stderr.write(
    `  docs/${file}\n    → ${detail ?? `imports \`${spec}\`, which is not an exported subpath of \`eve\``}\n\n`,
  );
}
process.stderr.write(
  `Valid \`eve\` subpaths come from packages/eve/package.json#exports. Fix the import or add the export.\n`,
);
process.exit(1);
