import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAF_CONFIG,
  DEFAULT_RUN_CONFIG,
  resolveLambdaRlmConfig,
  resolveLambdaRlmConfigWithSources,
  resolveRunConfig,
} from "../src/config-resolver.js";

async function tempConfigDirs() {
  const root = await mkdtemp(join(tmpdir(), "lambda-rlm-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return {
    globalConfigPath: join(home, ".pi", "lambda-rlm", "config.toml"),
    home,
    project,
    projectConfigPath: join(project, ".pi", "lambda-rlm", "config.toml"),
    root,
  };
}

async function writeToml(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

describe("TOML run config resolver", () => {
  it("uses built-in run-control defaults when no overlays exist", async () => {
    const dirs = await tempConfigDirs();

    await expect(
      resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home }),
    ).resolves.toStrictEqual({
      config: DEFAULT_RUN_CONFIG,
      ok: true,
    });
    await expect(
      resolveLambdaRlmConfig({ cwd: dirs.project, homeDir: dirs.home }),
    ).resolves.toStrictEqual({
      config: { leaf: DEFAULT_LEAF_CONFIG, run: DEFAULT_RUN_CONFIG },
      ok: true,
    });
  });

  it("reports home-directory config as global only when global and project paths are identical", async () => {
    const dirs = await tempConfigDirs();
    const homeProjectConfigPath = join(dirs.home, ".pi", "lambda-rlm", "config.toml");
    await writeToml(homeProjectConfigPath, '[leaf]\nmodel = "global/model"\n');

    await expect(
      resolveLambdaRlmConfigWithSources({ cwd: dirs.home, homeDir: dirs.home }),
    ).resolves.toStrictEqual({
      config: {
        config: {
          leaf: { ...DEFAULT_LEAF_CONFIG, model: "global/model" },
          run: DEFAULT_RUN_CONFIG,
        },
        sources: {
          exists: { global: true, project: false },
          leaf: { model: "global", thinking: "default" },
          paths: { global: homeProjectConfigPath, project: homeProjectConfigPath },
        },
      },
      ok: true,
    });
  });

  it("tracks which config layer owns the effective leaf thinking value", async () => {
    const dirs = await tempConfigDirs();
    await writeToml(dirs.globalConfigPath, '[leaf]\nthinking = "low"\n');
    await writeToml(dirs.projectConfigPath, '[leaf]\nthinking = "high"\n');

    await expect(
      resolveLambdaRlmConfigWithSources({ cwd: dirs.project, homeDir: dirs.home }),
    ).resolves.toMatchObject({
      config: {
        config: { leaf: { thinking: "high" } },
        sources: { leaf: { thinking: "project" } },
      },
      ok: true,
    });
  });

  it("applies sparse global and project overlays with project-over-global precedence", async () => {
    const dirs = await tempConfigDirs();
    await writeToml(
      dirs.globalConfigPath,
      [
        "[run]",
        "max_input_bytes = 1000",
        "output_max_bytes = 200",
        "max_model_calls = 8",
        "whole_run_timeout_ms = 5000",
        "model_process_concurrency = 3",
        "",
        "[leaf]",
        'model = "google/gemini-3-flash-preview"',
        'thinking = "off"',
      ].join("\n"),
    );
    await writeToml(
      dirs.projectConfigPath,
      [
        "[run]",
        "output_max_lines = 5",
        "output_max_bytes = 120",
        "model_call_timeout_ms = 900",
        "model_process_concurrency = 1",
        "",
        "[leaf]",
        'model = "local-vllm/qwen"',
        'pi_executable = "pi-dev"',
      ].join("\n"),
    );

    await expect(
      resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home }),
    ).resolves.toStrictEqual({
      config: {
        maxInputBytes: 1000,
        maxModelCalls: 8,
        modelCallTimeoutMs: 900,
        modelProcessConcurrency: 1,
        outputMaxBytes: 120,
        outputMaxLines: 5,
        wholeRunTimeoutMs: 5000,
      },
      ok: true,
    });
    await expect(
      resolveLambdaRlmConfig({ cwd: dirs.project, homeDir: dirs.home }),
    ).resolves.toStrictEqual({
      config: {
        leaf: { model: "local-vllm/qwen", piExecutable: "pi-dev", thinking: "off" },
        run: {
          maxInputBytes: 1000,
          maxModelCalls: 8,
          modelCallTimeoutMs: 900,
          modelProcessConcurrency: 1,
          outputMaxBytes: 120,
          outputMaxLines: 5,
          wholeRunTimeoutMs: 5000,
        },
      },
      ok: true,
    });
  });

  it("allows per-run options to tighten but not loosen resolved limits", async () => {
    const dirs = await tempConfigDirs();
    await writeToml(
      dirs.globalConfigPath,
      "[run]\nmax_input_bytes = 1000\noutput_max_bytes = 200\noutput_max_lines = 10\nmax_model_calls = 4\nwhole_run_timeout_ms = 1000\nmodel_call_timeout_ms = 500\nmodel_process_concurrency = 2\n",
    );

    await expect(
      resolveRunConfig({
        cwd: dirs.project,
        homeDir: dirs.home,
        perRun: {
          maxInputBytes: 900,
          maxModelCalls: 3,
          modelCallTimeoutMs: 500,
          modelProcessConcurrency: 1,
          outputMaxBytes: 199,
          outputMaxLines: 10,
          wholeRunTimeoutMs: 900,
        },
      }),
    ).resolves.toStrictEqual({
      config: {
        maxInputBytes: 900,
        maxModelCalls: 3,
        modelCallTimeoutMs: 500,
        modelProcessConcurrency: 1,
        outputMaxBytes: 199,
        outputMaxLines: 10,
        wholeRunTimeoutMs: 900,
      },
      ok: true,
    });

    await expect(
      resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home, perRun: { outputMaxBytes: 201 } }),
    ).resolves.toMatchObject({
      error: { code: "per_run_limit_loosened", field: "outputMaxBytes" },
      ok: false,
    });
    await expect(
      resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home, perRun: { maxModelCalls: 5 } }),
    ).resolves.toMatchObject({
      error: { code: "per_run_limit_loosened", field: "maxModelCalls" },
      ok: false,
    });
    await expect(
      resolveRunConfig({
        cwd: dirs.project,
        homeDir: dirs.home,
        perRun: { modelProcessConcurrency: 3 },
      }),
    ).resolves.toMatchObject({
      error: { code: "per_run_limit_loosened", field: "modelProcessConcurrency" },
      ok: false,
    });
  });

  it.each([
    ["invalid_toml", "not toml", "invalid_toml"],
    ["unknown_key", "[run]\nmax_input_bytes = 100\nextra = 1\n", "unknown_config_key"],
    ["invalid_value", "[run]\nmax_input_bytes = 0\n", "invalid_config_value"],
    ["unknown_leaf_key", '[leaf]\nextra = "x"\n', "unknown_config_key"],
    ["invalid_leaf_model", '[leaf]\nmodel = ""\n', "invalid_config_value"],
    ["invalid_leaf_thinking", '[leaf]\nthinking = "maximum"\n', "invalid_config_value"],
    ["unknown_table", "[prompt]\nfoo = 1\n", "unknown_config_key"],
    ["duplicate_key", "[run]\nmax_input_bytes = 100\nmax_input_bytes = 90\n", "invalid_toml"],
    [
      "duplicate_table",
      "[run]\nmax_input_bytes = 100\n[run]\noutput_max_bytes = 90\n",
      "invalid_toml",
    ],
  ])("returns structured validation errors for %s", async (_name, toml, code) => {
    const dirs = await tempConfigDirs();
    await writeToml(dirs.globalConfigPath, toml);

    await expect(
      resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home }),
    ).resolves.toMatchObject({
      error: { code, field: expect.any(String), message: expect.any(String), type: "validation" },
      ok: false,
    });
  });
});
