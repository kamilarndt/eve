import { fileURLToPath } from "node:url";

import { loadDeclaration } from "../_shared.mjs";

const wrapperEntry = fileURLToPath(
  new URL("../entries/@aws-sdk/lambda-microvms.mjs", import.meta.url),
);

export default {
  packageName: "@aws-sdk/client-lambda-microvms",
  compiledPath: "@aws-sdk/client-lambda-microvms",
  bundling: "standalone",
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("@aws-sdk/client-lambda-microvms.d.ts"),
    },
  ],
};
