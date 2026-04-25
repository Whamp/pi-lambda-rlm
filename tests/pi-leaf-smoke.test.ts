import { describe, expect, it } from "vitest";
import { runFormalPiLeafModelCall } from "../src/leafRunner.js";

const runSmoke = process.env.PI_LAMBDA_RLM_LEAF_SMOKE === "1";
const leafModel = process.env.LAMBDA_RLM_LEAF_MODEL;

describe.runIf(runSmoke)("gated real pi -p Formal Leaf smoke", () => {
  it("runs one tiny real constrained child pi -p call when explicitly enabled", async () => {
    if (!leafModel) {
      throw new Error("Set LAMBDA_RLM_LEAF_MODEL to run PI_LAMBDA_RLM_LEAF_SMOKE=1.");
    }

    const result = await runFormalPiLeafModelCall(
      { requestId: "smoke-1", prompt: "Reply with exactly: leaf smoke ok" },
      { leafModel, leafThinking: "off", timeoutMs: 120_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.content.trim().length).toBeGreaterThan(0);
  });
});

describe.skipIf(runSmoke)("gated real pi -p Formal Leaf smoke", () => {
  it("skips unless PI_LAMBDA_RLM_LEAF_SMOKE=1 is set", () => {
    expect(runSmoke).toBe(false);
  });
});
