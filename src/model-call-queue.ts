import type { Awaitable, ModelCall } from "./leaf-runner.js";
import { ModelCallQueueCancelledError } from "./model-call-error.js";

export interface ModelCallQueueSnapshot {
  concurrency: number;
  active: number;
  queued: number;
}

interface QueuedCall {
  call: ModelCall;
  start: () => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

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
    return { active: this.active, concurrency: this.concurrency, queued: this.waiting.length };
  }

  run<T>(call: ModelCall, runner: (call: ModelCall) => Awaitable<T>): Promise<T> {
    // The queue must return a pending promise while work waits for capacity.
    // oxlint-disable-next-line promise/avoid-new
    return new Promise<T>((resolve, reject) => {
      const startRunner = () => {
        if (call.signal?.aborted) {
          reject(new ModelCallQueueCancelledError(call.requestId));
          this.drain();
          return;
        }
        this.active += 1;
        const settleRunner = async () => {
          try {
            resolve(await runner(call));
          } catch (error) {
            reject(error);
          } finally {
            this.active -= 1;
            this.drain();
          }
        };
        void settleRunner();
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
        if (queued.onAbort) {
          call.signal?.removeEventListener("abort", queued.onAbort);
        }
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
      if (!next) {
        return;
      }
      next.start();
    }
  }
}
