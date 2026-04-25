import { describe, expect, it } from "vitest";
import { ModelCallConcurrencyQueue } from "../src/model-call-queue.js";

function deferred<T = void>() {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  // Tests need a controllable deferred to assert queue ordering.
  // oxlint-disable-next-line promise/avoid-new
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, reject: rejectDeferred, resolve: resolveDeferred };
}

function rejectOnAbort(signal: AbortSignal | undefined, error: Error): Promise<never> {
  // AbortSignal is EventTarget-based; a one-shot promise is the clearest test seam.
  // oxlint-disable-next-line promise/avoid-new
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(error), { once: true });
  });
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("per-extension model call concurrency queue", () => {
  it("starts ready model calls immediately when capacity is available", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 2 });
    const started: string[] = [];

    const first = queue.run({ prompt: "", requestId: "a" }, () => {
      started.push("a");
      return "A";
    });
    const second = queue.run({ prompt: "", requestId: "b" }, () => {
      started.push("b");
      return "B";
    });

    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
    expect(started).toStrictEqual(["a", "b"]);
    expect(queue.snapshot()).toStrictEqual({ active: 0, concurrency: 2, queued: 0 });
  });

  it("waits in memory when capacity is exhausted and starts queued calls after release", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseFirst = deferred();
    const started: string[] = [];

    const first = queue.run({ prompt: "", requestId: "first" }, async () => {
      started.push("first");
      await releaseFirst.promise;
      return "first-result";
    });
    const second = queue.run({ prompt: "", requestId: "second" }, () => {
      started.push("second");
      return "second-result";
    });

    await tick();
    expect(started).toStrictEqual(["first"]);
    expect(queue.snapshot()).toStrictEqual({ active: 1, concurrency: 1, queued: 1 });

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first-result");
    await expect(second).resolves.toBe("second-result");
    expect(started).toStrictEqual(["first", "second"]);
    expect(queue.snapshot()).toStrictEqual({ active: 0, concurrency: 1, queued: 0 });
  });

  it("releases active slots after success and failure", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });

    await expect(queue.run({ prompt: "", requestId: "success" }, () => "ok")).resolves.toBe("ok");
    expect(queue.snapshot().active).toBe(0);

    await expect(
      queue.run({ prompt: "", requestId: "failure" }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(queue.snapshot()).toStrictEqual({ active: 0, concurrency: 1, queued: 0 });
  });

  it("releases active slots after cancellation so waiting calls can start", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const controller = new AbortController();
    const started: string[] = [];

    const first = queue.run(
      { prompt: "", requestId: "active", signal: controller.signal },
      (call) => {
        started.push("active");
        return rejectOnAbort(call.signal, new Error("active cancelled"));
      },
    );
    const second = queue.run({ prompt: "", requestId: "waiting" }, () => {
      started.push("waiting");
      return "waiting-result";
    });

    await tick();
    expect(queue.snapshot()).toStrictEqual({ active: 1, concurrency: 1, queued: 1 });
    controller.abort();

    await expect(first).rejects.toThrow("active cancelled");
    await expect(second).resolves.toBe("waiting-result");
    expect(started).toStrictEqual(["active", "waiting"]);
    expect(queue.snapshot()).toStrictEqual({ active: 0, concurrency: 1, queued: 0 });
  });

  it("does not start queued calls after their run is cancelled", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseFirst = deferred();
    const controller = new AbortController();
    const started: string[] = [];

    const first = queue.run({ prompt: "", requestId: "first" }, async () => {
      started.push("first");
      await releaseFirst.promise;
      return "first-result";
    });
    const second = queue.run({ prompt: "", requestId: "second", signal: controller.signal }, () => {
      started.push("second");
      return "second-result";
    });

    await tick();
    controller.abort();
    releaseFirst.resolve();

    await expect(first).resolves.toBe("first-result");
    await expect(second).rejects.toMatchObject({
      name: "ModelCallQueueCancelledError",
      requestId: "second",
    });
    expect(started).toStrictEqual(["first"]);
    expect(queue.snapshot()).toStrictEqual({ active: 0, concurrency: 1, queued: 0 });
  });

  it("shares capacity across simultaneous runs using the same extension-scoped queue", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseRunA = deferred();
    const events: string[] = [];

    const runA = queue.run({ prompt: "", requestId: "run-a-call" }, async () => {
      events.push("start:a");
      await releaseRunA.promise;
      events.push("finish:a");
      return "a";
    });
    const runB = queue.run({ prompt: "", requestId: "run-b-call" }, () => {
      events.push("start:b");
      return "b";
    });

    await tick();
    expect(events).toStrictEqual(["start:a"]);
    expect(queue.snapshot()).toStrictEqual({ active: 1, concurrency: 1, queued: 1 });

    releaseRunA.resolve();
    await expect(runA).resolves.toBe("a");
    await expect(runB).resolves.toBe("b");
    expect(events).toStrictEqual(["start:a", "finish:a", "start:b"]);
  });
});
