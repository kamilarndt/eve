import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

const wrapperEntry = fileURLToPath(
  new URL("../entries/@aws-sdk/s3-request-presigner.mjs", import.meta.url),
);

export default {
  packageName: "@aws-sdk/s3-request-presigner",
  compiledPath: "@aws-sdk/s3-request-presigner",
  bundling: "standalone",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@aws-sdk/s3-request-presigner.d.ts"),
    },
  ],
};
