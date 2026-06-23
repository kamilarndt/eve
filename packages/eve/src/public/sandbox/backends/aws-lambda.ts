import { createAwsLambdaMicrovmSandbox } from "#execution/sandbox/bindings/aws-lambda-microvms/backend.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import type { AwsLambdaMicrovmSandboxOptions } from "#public/sandbox/aws-lambda-microvm-sandbox.js";

/**
 * Constructs an explicit AWS Lambda MicroVM sandbox backend.
 *
 * The backend provisions eve-owned image versions and stores durable
 * full-filesystem checkpoints in the supplied S3 bucket. It is never selected
 * by {@link import("../index.js").defaultBackend}; configuring it always uses
 * real AWS resources, including during local development.
 */
export function awsLambdaMicrovm(options: AwsLambdaMicrovmSandboxOptions): SandboxBackend {
  return createAwsLambdaMicrovmSandbox({ options });
}
