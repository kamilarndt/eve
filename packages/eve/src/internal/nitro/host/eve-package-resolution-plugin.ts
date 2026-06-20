import { resolvePackageDependencyPath } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";

interface EvePackageResolutionPlugin {
  readonly name: string;
  resolveId(source: string): { readonly external: false; readonly id: string } | null;
}

function isEvePackageSpecifier(source: string): boolean {
  return source === EVE_PACKAGE_NAME || source.startsWith(`${EVE_PACKAGE_NAME}/`);
}

/**
 * Binds authored `eve/*` imports to the Eve installation running the build.
 *
 * Nitro otherwise externalizes the app's installed Eve dependency. A CLI
 * launched from another installation can then bundle its own runtime while
 * loading authored channel and tool APIs from the app's different version.
 */
export function createEvePackageResolutionPlugin(): EvePackageResolutionPlugin {
  return {
    name: "eve-package-resolution",
    resolveId(source) {
      if (!isEvePackageSpecifier(source)) {
        return null;
      }

      return {
        external: false,
        id: resolvePackageDependencyPath(source),
      };
    },
  };
}
