import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_CONFIG, resolveRunConfig } from "../src/configResolver.js";

async function tempConfigDirs() {
  const root = await mkdtemp(join(tmpdir(), "lambda-rlm-config-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  return {
    root,
    home,
    project,
    globalConfigPath: join(home, ".pi", "lambda-rlm", "config.toml"),
    projectConfigPath: join(project, ".pi", "lambda-rlm", "config.toml"),
  };
}

async function writeToml(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("TOML run config resolver", () => {
  it("uses built-in run-control defaults when no overlays exist", async () => {
    const dirs = await tempConfigDirs();

    await expect(resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home })).resolves.toEqual({ ok: true, config: DEFAULT_RUN_CONFIG });
  });

  it("applies sparse global and project overlays with project-over-global precedence", async () => {
    const dirs = await tempConfigDirs();
    await writeToml(dirs.globalConfigPath, "[run]\nmax_input_bytes = 1000\noutput_max_bytes = 200\nmax_model_calls = 8\nwhole_run_timeout_ms = 5000\n");
    await writeToml(dirs.projectConfigPath, "[run]\noutput_max_lines = 5\noutput_max_bytes = 120\nmodel_call_timeout_ms = 900\n");

    await expect(resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home })).resolves.toEqual({
      ok: true,
      config: {
        maxInputBytes: 1000,
        outputMaxBytes: 120,
        outputMaxLines: 5,
        maxModelCalls: 8,
        wholeRunTimeoutMs: 5000,
        modelCallTimeoutMs: 900,
      },
    });
  });

  it("allows per-run options to tighten but not loosen resolved limits", async () => {
    const dirs = await tempConfigDirs();
    await writeToml(dirs.globalConfigPath, "[run]\nmax_input_bytes = 1000\noutput_max_bytes = 200\noutput_max_lines = 10\nmax_model_calls = 4\nwhole_run_timeout_ms = 1000\nmodel_call_timeout_ms = 500\n");

    await expect(
      resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home, perRun: { maxInputBytes: 900, outputMaxBytes: 199, outputMaxLines: 10, maxModelCalls: 3, wholeRunTimeoutMs: 900, modelCallTimeoutMs: 500 } }),
    ).resolves.toEqual({ ok: true, config: { maxInputBytes: 900, outputMaxBytes: 199, outputMaxLines: 10, maxModelCalls: 3, wholeRunTimeoutMs: 900, modelCallTimeoutMs: 500 } });

    await expect(resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home, perRun: { outputMaxBytes: 201 } })).resolves.toMatchObject({
      ok: false,
      error: { code: "per_run_limit_loosened", field: "outputMaxBytes" },
    });
    await expect(resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home, perRun: { maxModelCalls: 5 } })).resolves.toMatchObject({
      ok: false,
      error: { code: "per_run_limit_loosened", field: "maxModelCalls" },
    });
  });

  it.each([
    ["invalid_toml", "not toml", "invalid_toml"],
    ["unknown_key", "[run]\nmax_input_bytes = 100\nextra = 1\n", "unknown_config_key"],
    ["invalid_value", "[run]\nmax_input_bytes = 0\n", "invalid_config_value"],
    ["unknown_table", "[prompt]\nfoo = 1\n", "unknown_config_key"],
    ["duplicate_key", "[run]\nmax_input_bytes = 100\nmax_input_bytes = 90\n", "invalid_toml"],
    ["duplicate_table", "[run]\nmax_input_bytes = 100\n[run]\noutput_max_bytes = 90\n", "invalid_toml"],
  ])("returns structured validation errors for %s", async (_name, toml, code) => {
    const dirs = await tempConfigDirs();
    await writeToml(dirs.globalConfigPath, toml);

    await expect(resolveRunConfig({ cwd: dirs.project, homeDir: dirs.home })).resolves.toMatchObject({
      ok: false,
      error: { type: "validation", code, message: expect.any(String), field: expect.any(String) },
    });
  });
});
