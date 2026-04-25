import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runLambdaRlmDoctor } from "../src/doctor.js";
import type { ProcessRunner } from "../src/leafRunner.js";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "lambda-rlm-doctor-test-"));
}

const okRunner: ProcessRunner = async (invocation) => {
  if (invocation.command === "python3") {
    if (invocation.args.includes("--version")) return { exitCode: 0, stdout: "Python 3.12.0\n", stderr: "" };
    return { exitCode: 0, stdout: JSON.stringify({ ok: true, seams: ["LambdaRLM.client", "LambdaPromptRegistry", "completion_with_metadata"] }) + "\n", stderr: "" };
  }
  if (invocation.command === "pi") return { exitCode: 0, stdout: "pi 0.0.0\n", stderr: "" };
  return { exitCode: 127, stdout: "", stderr: "missing" };
};

describe("lambda_rlm doctor diagnostics", () => {
  it("reports an actionable error for invalid resolved TOML configuration", async () => {
    const root = await tempDir();
    const projectConfigPath = join(root, ".pi", "lambda-rlm", "config.toml");
    await mkdir(join(root, ".pi", "lambda-rlm"), { recursive: true });
    await writeFile(projectConfigPath, "[run]\nmax_model_calls = 0\n", "utf8");

    const report = await runLambdaRlmDoctor({ cwd: root, projectConfigPath, processRunner: okRunner, mockBridgeRunner: async () => ({ ok: true, message: "mock bridge ok" }) });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "config",
      status: "error",
      message: expect.stringContaining("max_model_calls"),
      remediation: expect.stringContaining("config.toml"),
    }));
  });

  it("reports an actionable error for invalid prompt overlays", async () => {
    const root = await tempDir();
    const projectPromptDir = join(root, ".pi", "lambda-rlm", "prompts");
    await mkdir(projectPromptDir, { recursive: true });
    await writeFile(join(projectPromptDir, "TASK-DETECTION-PROMPT.md"), "Choose a task for <<bogus>>\n", "utf8");

    const report = await runLambdaRlmDoctor({ cwd: root, projectPromptDir, processRunner: okRunner, mockBridgeRunner: async () => ({ ok: true, message: "mock bridge ok" }) });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "prompts",
      status: "error",
      message: expect.stringContaining("unknown placeholder"),
      remediation: expect.stringContaining("prompt overlay"),
    }));
  });

  it("reports missing Python/dependency and missing Pi executable through injected process hooks", async () => {
    const runner: ProcessRunner = async (invocation) => {
      if (invocation.command === "python3" && invocation.args.includes("--version")) {
        return { exitCode: 127, stdout: "", stderr: "python3: command not found" };
      }
      if (invocation.command === "python3") {
        return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: "No module named rlm" }) + "\n", stderr: "Traceback" };
      }
      if (invocation.command === "pi") return { exitCode: 127, stdout: "", stderr: "pi: command not found" };
      return { exitCode: 127, stdout: "", stderr: "missing" };
    };

    const report = await runLambdaRlmDoctor({ processRunner: runner, mockBridgeRunner: async () => ({ ok: true, message: "mock bridge ok" }) });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "python", status: "error", remediation: expect.stringContaining("python") }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "lambda_rlm_dependency", status: "error", remediation: expect.stringContaining("vendored") }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "pi_executable", status: "error", remediation: expect.stringContaining("Pi") }));
  });

  it("checks local/fork Lambda-RLM client, prompt, and metadata seams", async () => {
    const runner: ProcessRunner = async (invocation) => {
      if (invocation.command === "python3" && invocation.args.includes("--version")) return { exitCode: 0, stdout: "Python 3.12\n", stderr: "" };
      if (invocation.command === "python3") return { exitCode: 0, stdout: JSON.stringify({ ok: false, missing: ["LambdaRLM client parameter", "LambdaPromptRegistry", "BaseLM.completion_with_metadata"] }) + "\n", stderr: "" };
      if (invocation.command === "pi") return { exitCode: 0, stdout: "pi\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const report = await runLambdaRlmDoctor({ processRunner: runner, mockBridgeRunner: async () => ({ ok: true, message: "mock bridge ok" }) });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "lambda_rlm_fork_seams",
      status: "error",
      message: expect.stringContaining("LambdaRLM client parameter"),
      remediation: expect.stringContaining("local/forked Lambda-RLM"),
    }));
  });

  it("reports mock bridge/tool success without real model credentials and verifies Formal Leaf command shape", async () => {
    const report = await runLambdaRlmDoctor({
      processRunner: okRunner,
      mockBridgeRunner: async () => ({ ok: true, message: "mock bridge completed", details: { modelCalls: 2 } }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: "mock_bridge", status: "ok", message: expect.stringContaining("mock bridge completed") }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "formal_leaf_command",
      status: "ok",
      details: expect.objectContaining({ requiredFlagsPresent: true }),
    }));
    expect(JSON.stringify(report)).not.toMatch(/pip install|npm install|auto-seed|wrote prompt/i);
  });
});
