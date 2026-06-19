import { posix } from "node:path";

import {
  isSafeFilename,
  isValidMediaType,
  MAX_DOWNLOAD_FILE_BYTES,
  type DownloadFileResult,
} from "#shared/download-file.js";
import { validateAbsoluteFilePath } from "#execution/sandbox/require-sandbox.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/** Input accepted by {@link executeDownloadFileOnSandbox}. */
export interface DownloadFileInput {
  readonly filePath: string;
  readonly filename?: string;
  readonly mediaType?: string;
}

/**
 * Reads one bounded sandbox file and returns a browser-downloadable data URL.
 * The byte cap protects the durable event stream from unbounded tool output.
 */
export async function executeDownloadFileOnSandbox(
  sandbox: SandboxSession,
  input: DownloadFileInput,
): Promise<DownloadFileResult> {
  validateAbsoluteFilePath(input.filePath);
  const filePath = normalizeWorkspacePath(input.filePath);

  const filename = input.filename ?? filenameFromPath(filePath);
  if (!isSafeFilename(filename)) {
    throw new Error(
      `filename must be a non-empty base name without path separators. Received: "${filename}".`,
    );
  }

  const mediaType = input.mediaType ?? DEFAULT_MEDIA_TYPE;
  if (!isValidMediaType(mediaType)) {
    throw new Error(`mediaType must be a valid MIME type. Received: "${mediaType}".`);
  }

  const stream = await sandbox.readFile({ path: filePath });
  if (stream === null) {
    throw new Error(
      `File not found: ${filePath}. Verify the path exists and is accessible in the sandbox.`,
    );
  }

  const content = await readBounded(stream, filePath);
  return {
    filename,
    mediaType,
    size: content.byteLength,
    type: "file",
    url: `data:${mediaType};base64,${Buffer.from(content).toString("base64")}`,
  };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;

      size += next.value.byteLength;
      if (size > MAX_DOWNLOAD_FILE_BYTES) {
        await reader.cancel();
        throw new Error(
          `File "${filePath}" exceeds the ${String(MAX_DOWNLOAD_FILE_BYTES)}-byte download limit. ` +
            "Use external object storage for larger artifacts.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function filenameFromPath(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function normalizeWorkspacePath(filePath: string): string {
  const normalized = posix.normalize(filePath);
  if (!normalized.startsWith("/workspace/")) {
    throw new Error(`download_file only supports files under /workspace. Received: "${filePath}".`);
  }
  return normalized;
}
