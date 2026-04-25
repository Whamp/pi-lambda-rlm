import type { ModelCall } from "./leafRunner.js";

export type ModelCallQueueSnapshot = {
  concurrency: number;
  active: number;
  queued: number;
};

export class ModelCallQueueCancelledError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`Queued model call ${requestId} was cancelled before it started.`);
    this.name = "ModelCallQueueCancelledError";
    this.requestId = requestId;
  }
}

type QueuedCall = {
  call: ModelCall;
  start: () => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
};

export class ModelCallConcurrencyQueue {
  readonly concurrency: number;
  private active = 0;
  private readonly waiting: QueuedCall[] = [];

  constructor(options: { concurrency: number }) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error("Model call concurrency must be a positive safe integer.");
    }
    this.concurrency = options.concurrency;
  }

  snapshot(): ModelCallQueueSnapshot {
    return { concurrency: this.concurrency, active: this.active, queued: this.waiting.length };
  }

  run<T>(call: ModelCall, runner: (call: ModelCall) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const startRunner = () => {
        if (call.signal?.aborted) {
          reject(new ModelCallQueueCancelledError(call.requestId));
          this.drain();
          return;
        }
        this.active += 1;
        void Promise.resolve()
          .then(() => runner(call))
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.drain();
          });
      };

      const queued: QueuedCall = { call, reject, start: startRunner };

      if (call.signal) {
        queued.onAbort = () => {
          const index = this.waiting.indexOf(queued);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(new ModelCallQueueCancelledError(call.requestId));
          }
        };
        if (call.signal.aborted) {
          reject(new ModelCallQueueCancelledError(call.requestId));
          return;
        }
        call.signal.addEventListener("abort", queued.onAbort, { once: true });
      }

      queued.start = () => {
        if (queued.onAbort) call.signal?.removeEventListener("abort", queued.onAbort);
        startRunner();
      };
      if (this.active < this.concurrency) {
        queued.start();
      } else {
        this.waiting.push(queued);
      }
    });
  }

  private drain() {
    while (this.active < this.concurrency) {
      const next = this.waiting.shift();
      if (!next) return;
      next.start();
    }
  }
}
