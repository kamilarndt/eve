interface AwsClientConfig {
  readonly region: string;
}

interface AwsCommandInput {
  readonly [key: string]: unknown;
}

export class S3Command {
  constructor(input: AwsCommandInput);
}

export class S3Client {
  constructor(config: AwsClientConfig);
  send(command: S3Command): Promise<Record<string, unknown>>;
  destroy(): void;
}

export class AbortMultipartUploadCommand extends S3Command {}
export class CompleteMultipartUploadCommand extends S3Command {}
export class CreateMultipartUploadCommand extends S3Command {}
export class DeleteObjectCommand extends S3Command {}
export class GetBucketLocationCommand extends S3Command {}
export class GetObjectCommand extends S3Command {}
export class HeadObjectCommand extends S3Command {}
export class PutObjectCommand extends S3Command {}
export class UploadPartCommand extends S3Command {}
