interface AwsClientConfig {
  readonly region: string;
}

interface AwsCommandInput {
  readonly [key: string]: unknown;
}

declare class AwsCommand {
  constructor(input: AwsCommandInput);
}

export class LambdaMicrovmsClient {
  constructor(config: AwsClientConfig);
  send(command: AwsCommand): Promise<Record<string, unknown>>;
  destroy(): void;
}

export class CreateMicrovmAuthTokenCommand extends AwsCommand {}
export class CreateMicrovmImageCommand extends AwsCommand {}
export class GetMicrovmCommand extends AwsCommand {}
export class GetMicrovmImageCommand extends AwsCommand {}
export class GetMicrovmImageVersionCommand extends AwsCommand {}
export class ListManagedMicrovmImagesCommand extends AwsCommand {}
export class ListManagedMicrovmImageVersionsCommand extends AwsCommand {}
export class ListMicrovmImagesCommand extends AwsCommand {}
export class ListMicrovmImageVersionsCommand extends AwsCommand {}
export class ResumeMicrovmCommand extends AwsCommand {}
export class RunMicrovmCommand extends AwsCommand {}
export class SuspendMicrovmCommand extends AwsCommand {}
export class TagResourceCommand extends AwsCommand {}
export class TerminateMicrovmCommand extends AwsCommand {}
