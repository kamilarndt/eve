export class DevToolsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "DevToolsApiError";
    this.code = code;
    this.status = status;
  }
}
