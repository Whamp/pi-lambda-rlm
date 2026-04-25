import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePromptBundle } from "../src/promptResolver.js";

async function tempRoot(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeOverlay(root: string, relativePath: string, content: string) {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("prompt overlay resolver", () => {
  it("loads private built-in QA and Formal Leaf defaults when no overlays exist", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");

    const result = await resolvePromptBundle({ homeDir, cwd });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.prompts["tasks/qa.md"]?.template).toContain("<<text>>");
    expect(result.bundle.prompts["tasks/qa.md"]?.template).toContain("<<query>>");
    expect(result.bundle.formalLeafSystemPrompt).toContain("bounded neural subroutine");
    expect(result.bundle.prompts["tasks/qa.md"]?.source.layer).toBe("built_in");
    expect(result.bundle.prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"]?.source.layer).toBe("built_in");
  });

  it("applies sparse global and project overlays file-by-file with project precedence and inheritance", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(homeDir, ".pi/lambda-rlm/prompts/tasks/qa.md", "GLOBAL QA <<query>> :: <<text>>");
    await writeOverlay(homeDir, ".pi/lambda-rlm/prompts/FORMAL-LEAF-SYSTEM-PROMPT.md", "GLOBAL SYSTEM");
    await writeOverlay(cwd, ".pi/lambda-rlm/prompts/tasks/qa.md", "PROJECT QA <<text>> / <<query>>");

    const result = await resolvePromptBundle({ homeDir, cwd });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundle.prompts["tasks/qa.md"]?.template).toBe("PROJECT QA <<text>> / <<query>>");
    expect(result.bundle.prompts["tasks/qa.md"]?.source.layer).toBe("project");
    expect(result.bundle.prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"]?.template).toBe("GLOBAL SYSTEM");
    expect(result.bundle.prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"]?.source.layer).toBe("global");
    expect(result.bundle.prompts["tasks/qa.md"]?.shadowedSources.map((source) => source.layer)).toEqual(["built_in", "global"]);
  });

  it("fails before execution on unknown placeholders and missing required placeholders", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwdUnknown = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(cwdUnknown, ".pi/lambda-rlm/prompts/tasks/qa.md", "Bad <<text>> <<query>> <<typo>>");

    const unknown = await resolvePromptBundle({ homeDir, cwd: cwdUnknown });
    expect(unknown).toMatchObject({ ok: false, error: { type: "validation", code: "unknown_prompt_placeholder", field: "tasks/qa.md" } });

    const cwdMissing = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(cwdMissing, ".pi/lambda-rlm/prompts/tasks/qa.md", "Bad <<text>> only");

    const missing = await resolvePromptBundle({ homeDir, cwd: cwdMissing });
    expect(missing).toMatchObject({ ok: false, error: { type: "validation", code: "missing_required_prompt_placeholder", field: "tasks/qa.md" } });
  });

  it("rejects unknown runtime prompt files", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(cwd, ".pi/lambda-rlm/prompts/tasks/unknown.md", "unused");

    const result = await resolvePromptBundle({ homeDir, cwd });

    expect(result).toMatchObject({ ok: false, error: { type: "validation", code: "unknown_prompt_file", field: "tasks/unknown.md" } });
  });

  it("ships copyable prompt templates but resolving prompts does not auto-seed runtime overlay directories", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");

    await expect(stat(".pi/extensions/lambda-rlm/prompt-templates/tasks/qa.md")).resolves.toMatchObject({});
    await expect(stat(".pi/extensions/lambda-rlm/prompt-templates/FORMAL-LEAF-SYSTEM-PROMPT.md")).resolves.toMatchObject({});

    const result = await resolvePromptBundle({ homeDir, cwd });

    expect(result.ok).toBe(true);
    await expect(readdir(join(homeDir, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
