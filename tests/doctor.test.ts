import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runLambdaRlmDoctor } from "../src/doctor.js";
import type { ProcessRunner } from "../src/leaf-runner.js";

function tempDir() {
  return mkdtemp(join(tmpdir(), "lambda-rlm-doctor-test-"));
}

async function writeLeafConfig(root: string, model = "google/gemini-3-flash-preview") {
  const projectConfigPath = join(root, ".pi", "lambda-rlm", "config.toml");
  await mkdir(join(root, ".pi", "lambda-rlm"), { recursive: true });
  await writeFile(projectConfigPath, `[leaf]\nmodel = "${model}"\n`, "utf-8");
  return projectConfigPath;
}

const okRunner: ProcessRunner = (invocation) => {
  if (invocation.command === "python3") {
    if (invocation.args.includes("--version")) {
      return { exitCode: 0, stdout: "Python 3.12.0\n", stderr: "" };
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        ok: true,
        seams: ["LambdaRLM.client", "LambdaPromptRegistry", "completion_with_metadata"],
      })}\n`,
    };
  }
  if (invocation.command === "pi") {
    return { exitCode: 0, stdout: "pi 0.0.0\n", stderr: "" };
  }
  return { exitCode: 127, stderr: "missing", stdout: "" };
};

const missingDependencyRunner: ProcessRunner = (invocation) => {
  if (invocation.command === "python3" && invocation.args.includes("--version")) {
    return { exitCode: 127, stderr: "python3: command not found", stdout: "" };
  }
  if (invocation.command === "python3") {
    return {
      exitCode: 1,
      stderr: "Traceback",
      stdout: `${JSON.stringify({ error: "No module named rlm", ok: false })}\n`,
    };
  }
  if (invocation.command === "pi") {
    return { exitCode: 127, stdout: "", stderr: "pi: command not found" };
  }
  return { exitCode: 127, stderr: "missing", stdout: "" };
};

const missingSeamsRunner: ProcessRunner = (invocation) => {
  if (invocation.command === "python3" && invocation.args.includes("--version")) {
    return { exitCode: 0, stdout: "Python 3.12\n", stderr: "" };
  }
  if (invocation.command === "python3") {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({
        missing: [
          "LambdaRLM client parameter",
          "LambdaPromptRegistry",
          "BaseLM.completion_with_metadata",
        ],
        ok: false,
      })}\n`,
      stderr: "",
    };
  }
  if (invocation.command === "pi") {
    return { exitCode: 0, stdout: "pi\n", stderr: "" };
  }
  return { exitCode: 0, stderr: "", stdout: "" };
};

describe("lambda_rlm doctor diagnostics", () => {
  it("defensively runs Workspace Scaffolding without notifying or overwriting before diagnostics", async () => {
    const root = await tempDir();
    const workspacePath = join(root, ".pi", "lambda-rlm");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "config.toml"), "# user config\n", "utf-8");

    await runLambdaRlmDoctor({
      cwd: root,
      processRunner: okRunner,
      workspacePath,
      mockBridgeRunner: () => ({ details: {}, message: "mock ok", ok: true }),
    });

    await expect(readFile(join(workspacePath, "config.toml"), "utf-8")).resolves.toBe(
      "# user config\n",
    );
    await expect(readFile(join(workspacePath, "README.md"), "utf-8")).resolves.toContain(
      "Lambda-RLM User Workspace",
    );
  });

  it("reports an actionable error for invalid resolved TOML configuration", async () => {
    const root = await tempDir();
    const projectConfigPath = join(root, ".pi", "lambda-rlm", "config.toml");
    await mkdir(join(root, ".pi", "lambda-rlm"), { recursive: true });
    await writeFile(projectConfigPath, "[run]\nmax_model_calls = 0\n", "utf-8");

    const report = await runLambdaRlmDoctor({
      cwd: root,
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge ok" }),
      processRunner: okRunner,
      projectConfigPath,
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("max_model_calls"),
        name: "config",
        remediation: expect.stringContaining("config.toml"),
        status: "error",
      }),
    );
  });

  it("reports an actionable error for invalid prompt overlays", async () => {
    const root = await tempDir();
    const projectPromptDir = join(root, ".pi", "lambda-rlm", "prompts");
    await mkdir(projectPromptDir, { recursive: true });
    await writeFile(
      join(projectPromptDir, "TASK-DETECTION-PROMPT.md"),
      "Choose a task for <<bogus>>\n",
      "utf-8",
    );

    const report = await runLambdaRlmDoctor({
      cwd: root,
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge ok" }),
      processRunner: okRunner,
      projectPromptDir,
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("unknown placeholder"),
        name: "prompts",
        remediation: expect.stringContaining("prompt overlay"),
        status: "error",
      }),
    );
  });

  it("reports missing Python/dependency and missing Pi executable through injected process hooks", async () => {
    const root = await tempDir();
    const projectConfigPath = await writeLeafConfig(root);

    const report = await runLambdaRlmDoctor({
      cwd: root,
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge ok" }),
      processRunner: missingDependencyRunner,
      projectConfigPath,
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "python",
        remediation: expect.stringContaining("python"),
        status: "error",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "lambda_rlm_dependency",
        remediation: expect.stringContaining("vendored"),
        status: "error",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: "pi_executable",
        remediation: expect.stringContaining("Pi"),
        status: "error",
      }),
    );
  });

  it("checks local/fork Lambda-RLM client, prompt, and metadata seams", async () => {
    const report = await runLambdaRlmDoctor({
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge ok" }),
      processRunner: missingSeamsRunner,
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("LambdaRLM client parameter"),
        name: "lambda_rlm_fork_seams",
        remediation: expect.stringContaining("local/forked Lambda-RLM"),
        status: "error",
      }),
    );
  });

  it("reports an actionable error when no Formal Leaf model is configured", async () => {
    const root = await tempDir();

    const report = await runLambdaRlmDoctor({
      cwd: root,
      env: {},
      homeDir: join(root, "home"),
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge ok" }),
      processRunner: okRunner,
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("[leaf].model"),
        name: "leaf_model",
        remediation: expect.stringContaining("~/.pi/lambda-rlm/config.toml"),
        status: "error",
      }),
    );
  });

  it("uses the configured leaf pi_executable for Pi availability and command-shape checks", async () => {
    const root = await tempDir();
    const projectConfigPath = join(root, ".pi", "lambda-rlm", "config.toml");
    await mkdir(join(root, ".pi", "lambda-rlm"), { recursive: true });
    await writeFile(
      projectConfigPath,
      '[leaf]\nmodel = "google/gemini-3-flash-preview"\npi_executable = "pi-dev"\n',
      "utf-8",
    );
    const seenCommands: string[] = [];
    const processRunner: ProcessRunner = (invocation) => {
      seenCommands.push(invocation.command);
      if (invocation.command === "python3") {
        return okRunner(invocation);
      }
      if (invocation.command === "pi-dev") {
        return { exitCode: 0, stdout: "pi-dev 0.0.0\n", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: `${invocation.command}: command not found` };
    };

    const report = await runLambdaRlmDoctor({
      cwd: root,
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge completed" }),
      processRunner,
      projectConfigPath,
    });

    expect(report.ok).toBeTruthy();
    expect(seenCommands).toContain("pi-dev");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({ piExecutable: "pi-dev" }),
        name: "pi_executable",
        status: "ok",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          command: expect.objectContaining({ command: "pi-dev" }),
        }),
        name: "formal_leaf_command",
        status: "ok",
      }),
    );
  });

  it("treats an env-only leaf model as not installed-use ready", async () => {
    const root = await tempDir();

    const report = await runLambdaRlmDoctor({
      cwd: root,
      env: { LAMBDA_RLM_LEAF_MODEL: "google/gemini-3-flash-preview" },
      homeDir: join(root, "home"),
      mockBridgeRunner: () => ({ ok: true, message: "mock bridge completed" }),
      processRunner: okRunner,
    });

    expect(report.ok).toBeFalsy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("LAMBDA_RLM_LEAF_MODEL"),
        name: "leaf_model",
        remediation: expect.stringContaining("config.toml"),
        status: "error",
      }),
    );
  });

  it("reports mock bridge/tool success without real model credentials and verifies Formal Leaf command shape", async () => {
    const root = await tempDir();
    const projectConfigPath = await writeLeafConfig(root);

    const report = await runLambdaRlmDoctor({
      cwd: root,
      mockBridgeRunner: () => ({
        details: { modelCalls: 2 },
        message: "mock bridge completed",
        ok: true,
      }),
      processRunner: okRunner,
      projectConfigPath,
    });

    expect(report.ok).toBeTruthy();
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("mock bridge completed"),
        name: "mock_bridge",
        status: "ok",
      }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          readOnlyTools: "read,grep,find,ls",
          readOnlyToolsPresent: true,
          requiredFlagsPresent: true,
        }),
        name: "formal_leaf_command",
        status: "ok",
      }),
    );
    expect(JSON.stringify(report)).not.toMatch(/pip install|npm install|auto-seed|wrote prompt/i);
  });
});
