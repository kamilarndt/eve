import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

const wrapperEntry = fileURLToPath(new URL("../entries/@aws-sdk/s3.mjs", import.meta.url));

export default {
  packageName: "@aws-sdk/client-s3",
  compiledPath: "@aws-sdk/client-s3",
  bundling: "standalone",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@aws-sdk/client-s3.d.ts"),
    },
  ],
};
