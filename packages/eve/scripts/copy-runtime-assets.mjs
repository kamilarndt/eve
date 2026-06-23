import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// These files are read at runtime by their compiled modules, so they must ship
// beside the JavaScript output instead of remaining source-only assets.
const runtimeAssetDirs = [
  "src/cli/commands/agent-prompt",
  "src/execution/sandbox/bindings/aws-lambda-microvms/controller",
];

export async function copyRuntimeAssets() {
  for (const relativePath of runtimeAssetDirs) {
    const destinationPath = join(packageRoot, "dist", relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(join(packageRoot, relativePath), destinationPath, { recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await copyRuntimeAssets();
}
