/** Model-facing name of the framework tool that exposes a sandbox file. */
export const DOWNLOAD_FILE_TOOL_NAME = "download_file";

/** Maximum raw file size carried inline through the durable event stream. */
export const MAX_DOWNLOAD_FILE_BYTES = 1024 * 1024;

const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** JSON-safe file payload emitted by {@link DOWNLOAD_FILE_TOOL_NAME}. */
export interface DownloadFileResult {
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly type: "file";
  readonly url: string;
}

/** Metadata shown to the model and tool renderers without the base64 payload. */
export interface DownloadFileMetadata {
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
}

/** Returns the payload when a tool result is a valid bounded download. */
export function parseDownloadFileResult(value: unknown): DownloadFileResult | undefined {
  if (value === null || typeof value !== "object") return undefined;

  if (
    !("type" in value) ||
    value.type !== "file" ||
    !("filename" in value) ||
    typeof value.filename !== "string" ||
    !isSafeFilename(value.filename) ||
    !("mediaType" in value) ||
    typeof value.mediaType !== "string" ||
    !isValidMediaType(value.mediaType) ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_DOWNLOAD_FILE_BYTES ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !isMatchingDataUrl(value.url, value.mediaType, value.size)
  ) {
    return undefined;
  }

  return {
    filename: value.filename,
    mediaType: value.mediaType,
    size: value.size,
    type: "file",
    url: value.url,
  };
}

/** Removes the inline data while preserving useful result metadata. */
export function downloadFileMetadata(result: DownloadFileResult): DownloadFileMetadata {
  return {
    filename: result.filename,
    mediaType: result.mediaType,
    size: result.size,
  };
}

/** Validates a MIME type before it is interpolated into a data URL. */
export function isValidMediaType(value: string): boolean {
  return MEDIA_TYPE_PATTERN.test(value);
}

/** Validates a browser download filename without rewriting it silently. */
export function isSafeFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function isMatchingDataUrl(url: string, mediaType: string, size: number): boolean {
  const prefix = `data:${mediaType};base64,`;
  if (!url.startsWith(prefix)) return false;

  const encoded = url.slice(prefix.length);
  if (encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) return false;

  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedSize = encoded.length === 0 ? 0 : (encoded.length / 4) * 3 - padding;
  return decodedSize === size;
}
