import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeLambdaRlmTool as executeLambdaRlmToolRaw } from "../src/lambda-rlm-tool.js";
import { runFormalPiLeafModelCall } from "../src/leaf-runner.js";

function unquoteEnvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadLocalEnv(path = join(process.cwd(), ".env")) {
  if (existsSync(path) === false) {
    return;
  }
  for (const rawLine of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const assignment = line.startsWith("export ") ? line.slice("export ".length) : line;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = assignment.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(assignment.slice(equalsIndex + 1));
    process.env[key] ??= value;
  }
}

function configuredLeafModel() {
  const leafModel = process.env.LAMBDA_RLM_LEAF_MODEL?.trim();
  if (leafModel) {
    return leafModel;
  }
  throw new Error(
    "Set LAMBDA_RLM_LEAF_MODEL in .env before running npm run test:pi-leaf-smoke. Copy .env.example to .env and set it to a model pattern accepted by pi --model, such as <provider>/<model-id>.",
  );
}

loadLocalEnv();
const leafModel = configuredLeafModel();

async function tempContextFile(content: string) {
  const dir = await mkdtemp(join(tmpdir(), "lambda-rlm-real-smoke-"));
  const path = join(dir, "context.txt");
  await writeFile(path, content, "utf-8");
  return path;
}

async function executeLambdaRlmTool(
  params: unknown,
  options: Parameters<typeof executeLambdaRlmToolRaw>[1] = {},
) {
  const isolatedHome =
    options.homeDir || options.globalConfigPath
      ? undefined
      : await mkdtemp(join(tmpdir(), "lambda-rlm-isolated-home-"));
  return executeLambdaRlmToolRaw(params, {
    ...(isolatedHome ? { homeDir: isolatedHome } : {}),
    ...options,
  });
}

describe("real pi -p Formal Leaf smoke", () => {
  it("runs one tiny real constrained child pi -p call", async () => {
    const result = await runFormalPiLeafModelCall(
      { prompt: "Reply with exactly: leaf smoke ok", requestId: "smoke-1" },
      { leafModel, leafThinking: "off", timeoutMs: 120_000 },
    );

    expect(result.ok).toBeTruthy();
    expect(result.content.trim().length).toBeGreaterThan(0);
  });

  it("runs one tiny real lambda_rlm tool QA through child pi -p", async () => {
    const contextPath = await tempContextFile("Project codename is Quartz Finch.");
    const result = await executeLambdaRlmTool(
      { contextPath, question: "What is the project codename?" },
      { leafModel, leafThinking: "off", leafTimeoutMs: 120_000 },
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
