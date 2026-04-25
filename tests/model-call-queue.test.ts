import { describe, expect, it } from "vitest";
import { ModelCallConcurrencyQueue } from "../src/modelCallQueue.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("per-extension model call concurrency queue", () => {
  it("starts ready model calls immediately when capacity is available", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 2 });
    const started: string[] = [];

    const first = queue.run({ requestId: "a", prompt: "" }, async () => {
      started.push("a");
      return "A";
    });
    const second = queue.run({ requestId: "b", prompt: "" }, async () => {
      started.push("b");
      return "B";
    });

    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
    expect(started).toEqual(["a", "b"]);
    expect(queue.snapshot()).toEqual({ concurrency: 2, active: 0, queued: 0 });
  });

  it("waits in memory when capacity is exhausted and starts queued calls after release", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseFirst = deferred();
    const started: string[] = [];

    const first = queue.run({ requestId: "first", prompt: "" }, async () => {
      started.push("first");
      await releaseFirst.promise;
      return "first-result";
    });
    const second = queue.run({ requestId: "second", prompt: "" }, async () => {
      started.push("second");
      return "second-result";
    });

    await tick();
    expect(started).toEqual(["first"]);
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 1, queued: 1 });

    releaseFirst.resolve();
    await expect(first).resolves.toBe("first-result");
    await expect(second).resolves.toBe("second-result");
    expect(started).toEqual(["first", "second"]);
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 0, queued: 0 });
  });

  it("releases active slots after success and failure", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });

    await expect(queue.run({ requestId: "success", prompt: "" }, async () => "ok")).resolves.toBe("ok");
    expect(queue.snapshot().active).toBe(0);

    await expect(
      queue.run({ requestId: "failure", prompt: "" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 0, queued: 0 });
  });

  it("releases active slots after cancellation so waiting calls can start", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const controller = new AbortController();
    const started: string[] = [];

    const first = queue.run({ requestId: "active", prompt: "", signal: controller.signal }, async (call) => {
      started.push("active");
      return new Promise<string>((_resolve, reject) => {
        call.signal?.addEventListener("abort", () => reject(new Error("active cancelled")), { once: true });
      });
    });
    const second = queue.run({ requestId: "waiting", prompt: "" }, async () => {
      started.push("waiting");
      return "waiting-result";
    });

    await tick();
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 1, queued: 1 });
    controller.abort();

    await expect(first).rejects.toThrow("active cancelled");
    await expect(second).resolves.toBe("waiting-result");
    expect(started).toEqual(["active", "waiting"]);
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 0, queued: 0 });
  });

  it("does not start queued calls after their run is cancelled", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseFirst = deferred();
    const controller = new AbortController();
    const started: string[] = [];

    const first = queue.run({ requestId: "first", prompt: "" }, async () => {
      started.push("first");
      await releaseFirst.promise;
      return "first-result";
    });
    const second = queue.run({ requestId: "second", prompt: "", signal: controller.signal }, async () => {
      started.push("second");
      return "second-result";
    });

    await tick();
    controller.abort();
    releaseFirst.resolve();

    await expect(first).resolves.toBe("first-result");
    await expect(second).rejects.toMatchObject({ name: "ModelCallQueueCancelledError", requestId: "second" });
    expect(started).toEqual(["first"]);
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 0, queued: 0 });
  });

  it("shares capacity across simultaneous runs using the same extension-scoped queue", async () => {
    const queue = new ModelCallConcurrencyQueue({ concurrency: 1 });
    const releaseRunA = deferred();
    const events: string[] = [];

    const runA = queue.run({ requestId: "run-a-call", prompt: "" }, async () => {
      events.push("start:a");
      await releaseRunA.promise;
      events.push("finish:a");
      return "a";
    });
    const runB = queue.run({ requestId: "run-b-call", prompt: "" }, async () => {
      events.push("start:b");
      return "b";
    });

    await tick();
    expect(events).toEqual(["start:a"]);
    expect(queue.snapshot()).toEqual({ concurrency: 1, active: 1, queued: 1 });

    releaseRunA.resolve();
    await expect(runA).resolves.toBe("a");
    await expect(runB).resolves.toBe("b");
    expect(events).toEqual(["start:a", "finish:a", "start:b"]);
  });
});
