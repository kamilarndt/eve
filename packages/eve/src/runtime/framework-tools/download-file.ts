import {
  executeDownloadFileOnSandbox,
  type DownloadFileInput,
} from "#execution/sandbox/download-file-tool.js";
import { requireSandboxSession } from "#execution/sandbox/require-sandbox.js";
import {
  downloadFileMetadata,
  DOWNLOAD_FILE_TOOL_NAME,
  MAX_DOWNLOAD_FILE_BYTES,
  parseDownloadFileResult,
} from "#shared/download-file.js";
import type { JsonObject } from "#shared/json.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

export const DOWNLOAD_FILE_INPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    filePath: {
      description: "Absolute path of the sandbox file to make downloadable.",
      type: "string",
    },
    filename: {
      description: "Optional download filename. Must not contain path separators.",
      type: "string",
    },
    mediaType: {
      description: "Optional MIME type. Defaults to application/octet-stream.",
      type: "string",
    },
  },
  required: ["filePath"],
  type: "object",
};

export const DOWNLOAD_FILE_OUTPUT_SCHEMA: JsonObject = {
  additionalProperties: false,
  properties: {
    filename: { type: "string" },
    mediaType: { type: "string" },
    size: { minimum: 0, maximum: MAX_DOWNLOAD_FILE_BYTES, type: "integer" },
    type: { const: "file", type: "string" },
    url: { type: "string" },
  },
  required: ["filename", "mediaType", "size", "type", "url"],
  type: "object",
};

async function executeDownloadFile(input: unknown): Promise<unknown> {
  return await executeDownloadFileOnSandbox(
    await requireSandboxSession(),
    parseDownloadFileInput(input),
  );
}

export const DOWNLOAD_FILE_TOOL_DEFINITION: ResolvedToolDefinition = {
  description: [
    "Make a sandbox file available for the user to download.",
    "",
    "Usage:",
    "- Call this after creating a file the user asked to receive.",
    "- Use an absolute path under /workspace.",
    `- Files larger than ${String(MAX_DOWNLOAD_FILE_BYTES)} bytes are rejected.`,
    "- This tool is for delivering a file, not reading its contents.",
  ].join("\n"),
  execute: executeDownloadFile,
  inputSchema: DOWNLOAD_FILE_INPUT_SCHEMA,
  logicalPath: "eve:framework/download-file",
  name: DOWNLOAD_FILE_TOOL_NAME,
  outputSchema: DOWNLOAD_FILE_OUTPUT_SCHEMA,
  sourceId: "eve:download-file-tool",
  sourceKind: "module",
  toModelOutput(output) {
    const result = parseDownloadFileResult(output);
    if (result === undefined) {
      return { type: "text", value: "The file could not be prepared for download." };
    }
    const metadata = downloadFileMetadata(result);
    return {
      type: "text",
      value: `Made ${metadata.filename} (${String(metadata.size)} bytes) available for download.`,
    };
  },
};

function parseDownloadFileInput(value: unknown): DownloadFileInput {
  if (
    value === null ||
    typeof value !== "object" ||
    !("filePath" in value) ||
    typeof value.filePath !== "string"
  ) {
    throw new TypeError("download_file requires a string filePath.");
  }

  const filename = "filename" in value ? value.filename : undefined;
  if (filename !== undefined && typeof filename !== "string") {
    throw new TypeError("download_file filename must be a string when provided.");
  }

  const mediaType = "mediaType" in value ? value.mediaType : undefined;
  if (mediaType !== undefined && typeof mediaType !== "string") {
    throw new TypeError("download_file mediaType must be a string when provided.");
  }

  return { filePath: value.filePath, filename, mediaType };
}
