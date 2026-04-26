import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFormalLeafModelSelection } from "../src/targeted-config-edit.js";

async function tempConfig(content?: string) {
  const root = await mkdtemp(join(tmpdir(), "lambda-rlm-targeted-edit-"));
  const configPath = join(root, "config.toml");
  if (content !== undefined) {
    await writeFile(configPath, content, "utf-8");
  }
  return configPath;
}

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
});
