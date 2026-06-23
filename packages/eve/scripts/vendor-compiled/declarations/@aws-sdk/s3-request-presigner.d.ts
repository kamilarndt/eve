import type { S3Client, S3Command } from "#compiled/@aws-sdk/client-s3/index.js";

export function getSignedUrl(
  client: S3Client,
  command: S3Command,
  options?: { readonly expiresIn?: number },
): Promise<string>;
