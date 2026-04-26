import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveLambdaRlmConfig } from "../src/config-resolver.js";
import { executeLambdaRlmTool as executeLambdaRlmToolRaw } from "../src/lambda-rlm-tool.js";
import { runFormalPiLeafModelCall } from "../src/leaf-runner.js";
import type { LeafConfig } from "../src/config-resolver.js";

async function configuredLeafConfig() {
  const result = await resolveLambdaRlmConfig({ cwd: process.cwd() });
  if (!result.ok) {
    throw new Error(`Fix Lambda-RLM config before smoke testing: ${result.error.message}`);
  }
  if (!result.config.leaf.model) {
    throw new Error(
      'Create ~/.pi/lambda-rlm/config.toml or .pi/lambda-rlm/config.toml with [leaf]\nmodel = "<provider>/<model-id>" before running npm run test:pi-leaf-smoke.',
    );
  }
  return result.config.leaf as LeafConfig & { model: string };
}

let leafConfig!: LeafConfig & { model: string };

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-real-smoke-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf-8");
  return path;
}

describe("real pi -p Formal Leaf smoke", () => {
  beforeAll(async () => {
    leafConfig = await configuredLeafConfig();
  });
  it("runs one tiny real constrained child pi -p call", async () => {
    const result = await runFormalPiLeafModelCall(
      { prompt: "Reply with exactly: leaf smoke ok", requestId: "smoke-1" },
      {
        leafModel: leafConfig.model,
        leafThinking: leafConfig.thinking,
        piExecutable: leafConfig.piExecutable,
        timeoutMs: 120_000,
      },
    );

    expect(result.ok).toBeTruthy();
    expect(result.content.trim().length).toBeGreaterThan(0);
  });

  it("runs one tiny real lambda_rlm tool QA through child pi -p", async () => {
    const contextPath = await tempContextFile("Project codename is Quartz Finch.");
    const result = await executeLambdaRlmToolRaw(
      { contextPath, question: "What is the project codename?" },
      { leafTimeoutMs: 120_000 },
    );

    const text = result.content[0]?.text ?? "";
    expect(text.trim().length).toBeGreaterThan(0);
    expect(result.details).toMatchObject({
      bridgeRun: {
        leafProfile: "formal_pi_print",
        realLambdaRlm: true,
      },
      ok: true,
    });
  }, 180_000);
});
