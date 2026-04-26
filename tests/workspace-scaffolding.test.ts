import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLambdaRlmConfig } from "../src/config-resolver.js";
import { ensureLambdaRlmUserWorkspace } from "../src/workspace-scaffolding.js";

async function tempWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "lambda-rlm-workspace-scaffold-"));
  return join(root, ".pi", "lambda-rlm");
}

function read(path: string) {
  return readFile(path, "utf-8");
}

describe("Lambda-RLM User Workspace Scaffolding", () => {
  it("creates a fresh Lambda-RLM User Workspace with a valid Transparent Sparse Config Scaffold, Copied Example Fixtures, and README", async () => {
    const workspacePath = await tempWorkspace();

    const result = await ensureLambdaRlmUserWorkspace({ workspacePath });

    expect(result.createdWorkspace).toBeTruthy();
    expect(result.createdFiles).toStrictEqual(
      expect.arrayContaining([
        join(workspacePath, "config.toml"),
        join(workspacePath, "README.md"),
        join(workspacePath, "examples", "single-file-qa", "context.md"),
      ]),
    );
    expect(existsSync(join(workspacePath, "prompts"))).toBeFalsy();

    const configText = await read(join(workspacePath, "config.toml"));
    expect(configText).toContain("# model =");
    expect(configText).not.toMatch(/^\s*model\s*=/m);
    expect(configText).toMatch(/^thinking = "off"$/m);
    expect(configText).toMatch(/^pi_executable = "pi"$/m);
    for (const runKey of [
      "max_input_bytes",
      "output_max_bytes",
      "output_max_lines",
      "max_model_calls",
      "whole_run_timeout_ms",
      "model_call_timeout_ms",
      "model_process_concurrency",
    ]) {
      expect(configText).toMatch(new RegExp(`^# ${runKey} =`, "m"));
      expect(configText).not.toMatch(new RegExp(`^${runKey} =`, "m"));
    }

    await expect(
      resolveLambdaRlmConfig({
        cwd: join(workspacePath, "project"),
        globalConfigPath: join(workspacePath, "config.toml"),
      }),
    ).resolves.toMatchObject({
      ok: true,
      config: { leaf: { piExecutable: "pi", thinking: "off" } },
    });

    const workspaceReadme = await read(join(workspacePath, "README.md"));
    expect(workspaceReadme).toContain("Run `/lambda-rlm-doctor` first");
    expect(workspaceReadme).toContain("Formal Leaf Model Selection");
    expect(workspaceReadme).toContain("diagnostics");
    expect(workspaceReadme).toContain("Manually edit `[leaf].model` only as a fallback");
    expect(workspaceReadme).toContain("non-interactive or diagnostic-only contexts");
    await expect(
      read(join(workspacePath, "examples", "multi-file-qa", "README.md")),
    ).resolves.toContain("Multi-file QA");
  });

  it("fills only missing scaffold files in a partial workspace and reports no first-create notification state", async () => {
    const workspacePath = await tempWorkspace();
    await mkdir(join(workspacePath, "examples", "single-file-qa"), { recursive: true });
    await writeFile(
      join(workspacePath, "config.toml"),
      '[leaf]\nmodel = "custom/model"\n',
      "utf-8",
    );
    await writeFile(
      join(workspacePath, "examples", "single-file-qa", "context.md"),
      "user-edited fixture",
      "utf-8",
    );

    const result = await ensureLambdaRlmUserWorkspace({ workspacePath });

    expect(result.createdWorkspace).toBeFalsy();
    expect(result.createdFiles).toStrictEqual(
      expect.arrayContaining([
        join(workspacePath, "README.md"),
        join(workspacePath, "examples", "multi-file-qa", "design.md"),
      ]),
    );
    await expect(read(join(workspacePath, "config.toml"))).resolves.toBe(
      '[leaf]\nmodel = "custom/model"\n',
    );
    await expect(
      read(join(workspacePath, "examples", "single-file-qa", "context.md")),
    ).resolves.toBe("user-edited fixture");
  });

  it("never overwrites existing config, README, Copied Example Fixtures, or prompt overlays and is idempotent", async () => {
    const workspacePath = await tempWorkspace();
    await mkdir(join(workspacePath, "examples", "synthesis"), { recursive: true });
    await mkdir(join(workspacePath, "prompts"), { recursive: true });
    await writeFile(join(workspacePath, "config.toml"), "custom config", "utf-8");
    await writeFile(join(workspacePath, "README.md"), "custom readme", "utf-8");
    await writeFile(
      join(workspacePath, "examples", "synthesis", "README.md"),
      "custom example",
      "utf-8",
    );
    await writeFile(
      join(workspacePath, "prompts", "FORMAL-LEAF-SYSTEM-PROMPT.md"),
      "custom prompt",
      "utf-8",
    );

    await ensureLambdaRlmUserWorkspace({ workspacePath });
    const second = await ensureLambdaRlmUserWorkspace({ workspacePath });

    expect(second).toStrictEqual({
      createdDirectories: [],
      createdFiles: [],
      createdWorkspace: false,
    });
    await expect(read(join(workspacePath, "config.toml"))).resolves.toBe("custom config");
    await expect(read(join(workspacePath, "README.md"))).resolves.toBe("custom readme");
    await expect(read(join(workspacePath, "examples", "synthesis", "README.md"))).resolves.toBe(
      "custom example",
    );
    await expect(
      read(join(workspacePath, "prompts", "FORMAL-LEAF-SYSTEM-PROMPT.md")),
    ).resolves.toBe("custom prompt");
  });
});
