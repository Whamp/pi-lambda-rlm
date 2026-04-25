import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLambdaRlmTool as executeLambdaRlmToolRaw } from "../src/lambdaRlmTool.js";
import { runFormalPiLeafModelCall } from "../src/leafRunner.js";

const runSmoke = process.env.PI_LAMBDA_RLM_LEAF_SMOKE === "1";
const leafModel = process.env.LAMBDA_RLM_LEAF_MODEL;

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-real-smoke-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf8");
  return path;
}

async function executeLambdaRlmTool(params: unknown, options: Parameters<typeof executeLambdaRlmToolRaw>[1] = {}) {
  const isolatedHome = options.homeDir || options.globalConfigPath ? undefined : await mkdtemp(join(tmpdir(), "lambda-rlm-isolated-home-"));
  return executeLambdaRlmToolRaw(params, { ...(isolatedHome ? { homeDir: isolatedHome } : {}), ...options });
}

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

  it("runs one tiny real lambda_rlm tool QA through child pi -p when explicitly enabled", async () => {
    if (!leafModel) {
      throw new Error("Set LAMBDA_RLM_LEAF_MODEL to run PI_LAMBDA_RLM_LEAF_SMOKE=1.");
    }

    const contextPath = await tempContextFile("Project codename is Quartz Finch.");
    const result = await executeLambdaRlmTool(
      { contextPath, question: "What is the project codename?" },
      { leafModel, leafThinking: "off", leafTimeoutMs: 120_000 },
    );

    const text = result.content[0]?.text ?? "";
    expect(text.trim().length).toBeGreaterThan(0);
    expect(result.details).toMatchObject({
      ok: true,
      bridgeRun: {
        realLambdaRlm: true,
        leafProfile: "formal_pi_print",
      },
    });
  }, 180_000);
});

describe.skipIf(runSmoke)("gated real pi -p Formal Leaf smoke", () => {
  it("skips unless PI_LAMBDA_RLM_LEAF_SMOKE=1 is set", () => {
    expect(runSmoke).toBe(false);
  });
});
