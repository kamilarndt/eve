import { defineEval } from "eve/evals";

const DOWNLOAD_TOKEN = "sandbox-download-ok-N4P";
const DOWNLOAD_PATH = "/workspace/download-report.txt";

export default defineEval({
  description: "Sandbox: a generated file is exposed through download_file.",
  async test(t) {
    const turn = await t.send(
      [
        `Use write_file to create ${DOWNLOAD_PATH} with exactly this content: ${DOWNLOAD_TOKEN}`,
        `Then use download_file to make ${DOWNLOAD_PATH} available with mediaType text/plain.`,
        "Reply briefly when it is ready.",
      ].join("\n"),
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.calledTool("write_file", { isError: false });
    t.calledTool("download_file", {
      input: { filePath: DOWNLOAD_PATH, mediaType: "text/plain" },
      isError: false,
      output: {
        filename: "download-report.txt",
        mediaType: "text/plain",
        size: DOWNLOAD_TOKEN.length,
        type: "file",
        url: /^data:text\/plain;base64,/,
      },
    });
  },
});
