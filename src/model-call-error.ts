export class ModelCallQueueCancelledError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`Queued model call ${requestId} was cancelled before it started.`);
    this.name = "ModelCallQueueCancelledError";
    this.requestId = requestId;
  }
}
