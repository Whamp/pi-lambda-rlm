import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeRewriteInvalidConfig,
  writeFormalLeafModelSelection,
  writeFormalLeafThinkingSelection,
} from "../src/targeted-config-edit.js";

async function tempConfig(content?: string) {
  const root = await mkdtemp(join(tmpdir(), "lambda-rlm-targeted-edit-"));
  const configPath = join(root, "config.toml");
  if (content !== undefined) {
    await writeFile(configPath, content, "utf-8");
  }
  return configPath;
}

describe("Targeted Config Edit for Formal Leaf Thinking Selection", () => {
  it("updates existing leaf thinking assignments in place while preserving comments and ordering", async () => {
    const configPath = await tempConfig(
      `# top comment\n[leaf]\nmodel = "local/qwen"\nthinking = "off" # baseline\npi_executable = "pi"\n\n[run]\nmax_model_calls = 3\n`,
    );

    const result = await writeFormalLeafThinkingSelection({ configPath, thinking: "high" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `# top comment\n[leaf]\nmodel = "local/qwen"\nthinking = "high" # baseline\npi_executable = "pi"\n\n[run]\nmax_model_calls = 3\n`,
    );
    expect(result.kind).toBe("updated_existing_assignment");
  });

  it("updates existing leaf assignments with inline comments that have no preceding whitespace", async () => {
    const configPath = await tempConfig(
      `[leaf]\nmodel = "old/provider"# baseline\nthinking = "off"# baseline\n`,
    );

    const modelResult = await writeFormalLeafModelSelection({ configPath, model: "new/provider" });
    const thinkingResult = await writeFormalLeafThinkingSelection({ configPath, thinking: "high" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\nmodel = "new/provider"# baseline\nthinking = "high"# baseline\n`,
    );
    expect(modelResult.kind).toBe("updated_existing_assignment");
    expect(thinkingResult.kind).toBe("updated_existing_assignment");
  });

  it("uncomments and updates commented scaffold thinking lines", async () => {
    const configPath = await tempConfig(
      `[leaf]\nmodel = "local/qwen"\n# thinking = "off"\npi_executable = "pi"\n`,
    );

    const result = await writeFormalLeafThinkingSelection({ configPath, thinking: "medium" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\nmodel = "local/qwen"\nthinking = "medium"\npi_executable = "pi"\n`,
    );
    expect(result.kind).toBe("uncommented_scaffold_assignment");
  });

  it("appends missing thinking assignments inside an existing leaf table without reordering comments", async () => {
    const configPath = await tempConfig(
      `[leaf]\n# keep leaf note\nmodel = "local/qwen"\n\n[run]\nmax_model_calls = 3\n`,
    );

    const result = await writeFormalLeafThinkingSelection({ configPath, thinking: "minimal" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\n# keep leaf note\nmodel = "local/qwen"\nthinking = "minimal"\n\n[run]\nmax_model_calls = 3\n`,
    );
    expect(result.kind).toBe("appended_to_existing_leaf_table");
  });

  it("adds a leaf table for missing thinking assignments when no leaf table exists", async () => {
    const configPath = await tempConfig(`[run]\nmax_model_calls = 3\n`);

    const result = await writeFormalLeafThinkingSelection({ configPath, thinking: "low" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[run]\nmax_model_calls = 3\n\n[leaf]\nthinking = "low"\n`,
    );
    expect(result.kind).toBe("added_leaf_table");
  });

  it("rejects unsupported Formal Leaf thinking values using the validation contract", async () => {
    const configPath = await tempConfig(`[leaf]\nmodel = "local/qwen"\n`);

    await expect(
      writeFormalLeafThinkingSelection({ configPath, thinking: "max" as never }),
    ).rejects.toThrow(
      "Formal Leaf thinking must be one of: off, minimal, low, medium, high, xhigh.",
    );
    await expect(readFile(configPath, "utf-8")).resolves.toBe(`[leaf]\nmodel = "local/qwen"\n`);
  });
});

describe("Targeted Config Edit for Formal Leaf Model Selection", () => {
  it("updates existing leaf model assignments in place while preserving comments and ordering", async () => {
    const configPath = await tempConfig(
      `# top comment\n[run]\nmax_model_calls = 7\n\n[leaf]\n# keep this note\nmodel = "old/provider" # existing choice\nthinking = "off"\n\n# tail\n`,
    );

    const result = await writeFormalLeafModelSelection({ configPath, model: "new/provider" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `# top comment\n[run]\nmax_model_calls = 7\n\n[leaf]\n# keep this note\nmodel = "new/provider" # existing choice\nthinking = "off"\n\n# tail\n`,
    );
    expect(result.kind).toBe("updated_existing_assignment");
  });

  it("uncomments and updates commented scaffold model lines", async () => {
    const configPath = await tempConfig(
      `[leaf]\n# Add a Formal Leaf model manually.\n# model = "<provider>/<model-id>"\nthinking = "off"\n`,
    );

    const result = await writeFormalLeafModelSelection({ configPath, model: "local/qwen" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\n# Add a Formal Leaf model manually.\nmodel = "local/qwen"\nthinking = "off"\n`,
    );
    expect(result.kind).toBe("uncommented_scaffold_assignment");
  });

  it("appends missing model assignments inside an existing leaf table before the next table", async () => {
    const configPath = await tempConfig(
      `[leaf]\nthinking = "off"\n# leaf note\n\n[run]\nmax_model_calls = 3\n`,
    );

    const result = await writeFormalLeafModelSelection({ configPath, model: "anthropic/claude" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\nthinking = "off"\n# leaf note\nmodel = "anthropic/claude"\n\n[run]\nmax_model_calls = 3\n`,
    );
    expect(result.kind).toBe("appended_to_existing_leaf_table");
  });

  it("appends a missing model on a new line when an existing leaf table has no trailing newline", async () => {
    const configPath = await tempConfig(`[leaf]`);

    const result = await writeFormalLeafModelSelection({ configPath, model: "anthropic/claude" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\nmodel = "anthropic/claude"\n`,
    );
    expect(result.kind).toBe("appended_to_existing_leaf_table");
  });

  it("appends a missing model after existing leaf settings with no trailing newline", async () => {
    const configPath = await tempConfig(`[leaf]\nthinking = "off"`);

    const result = await writeFormalLeafModelSelection({ configPath, model: "anthropic/claude" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\nthinking = "off"\nmodel = "anthropic/claude"\n`,
    );
    expect(result.kind).toBe("appended_to_existing_leaf_table");
  });

  it("preserves existing trailing-newline behavior when appending a missing model", async () => {
    const configPath = await tempConfig(`[leaf]\nthinking = "off"\n`);

    const result = await writeFormalLeafModelSelection({ configPath, model: "anthropic/claude" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(
      `[leaf]\nthinking = "off"\nmodel = "anthropic/claude"\n`,
    );
    expect(result.kind).toBe("appended_to_existing_leaf_table");
  });

  it("adds a leaf table when no leaf table exists and creates missing global config files", async () => {
    const root = await mkdtemp(join(tmpdir(), "lambda-rlm-targeted-global-"));
    const configPath = join(root, ".pi", "lambda-rlm", "config.toml");

    const result = await writeFormalLeafModelSelection({ configPath, model: "google/gemini" });

    await expect(readFile(configPath, "utf-8")).resolves.toBe(`[leaf]\nmodel = "google/gemini"\n`);
    expect(result.kind).toBe("added_leaf_table");
  });

  it("blocks Targeted Config Edit for Formal Leaf Model Selection when TOML is structurally unsafe", async () => {
    const configPath = await tempConfig(`[leaf]\nmodel = `);

    await expect(
      writeFormalLeafModelSelection({ configPath, model: "local/qwen" }),
    ).rejects.toMatchObject({ code: "unsafe_config_edit" });
    await expect(readFile(configPath, "utf-8")).resolves.toBe(`[leaf]\nmodel = `);
  });

  it("requires explicit confirmation before normalized rewrite and preserves invalid config without it", async () => {
    const configPath = await tempConfig(`[leaf]\nmodel = `);

    const result = await normalizeRewriteInvalidConfig({ configPath, confirmed: false });

    expect(result.rewritten).toBeFalsy();
    await expect(readFile(configPath, "utf-8")).resolves.toBe(`[leaf]\nmodel = `);
  });

  it("creates a backup before confirmed normalized rewrite of invalid config", async () => {
    const configPath = await tempConfig(`[leaf]\nmodel = `);

    const result = await normalizeRewriteInvalidConfig({ configPath, confirmed: true });

    if (!result.rewritten) {
      throw new Error("expected confirmed normalized rewrite to occur");
    }
    expect(result.backupPath).toContain("config.toml.invalid.");
    await expect(readFile(result.backupPath, "utf-8")).resolves.toBe(`[leaf]\nmodel = `);
    await expect(stat(result.backupPath)).resolves.toBeTruthy();
    await expect(readFile(configPath, "utf-8")).resolves.toContain(
      '# model = "<provider>/<model-id>"',
    );
  });
});
