import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptKeys, resolvePromptBundle } from "../src/prompt-resolver.js";

function tempRoot(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

function sortedStrings(values: Iterable<string>) {
  const sorted = [...values];
  // ES2022 target: Array#toSorted is unavailable in this project.
  // oxlint-disable-next-line unicorn/no-array-sort
  return sorted.sort();
}

async function writeOverlay(root: string, relativePath: string, content: string) {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

describe("prompt overlay resolver", () => {
  it("loads private built-in defaults for the full prompt surface when no overlays exist", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");

    const result = await resolvePromptBundle({ cwd, homeDir });

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(sortedStrings(Object.keys(result.bundle.prompts))).toStrictEqual(
      sortedStrings(promptKeys()),
    );
    for (const key of promptKeys()) {
      expect(result.bundle.prompts[key]?.source.layer).toBe("built_in");
    }
    expect(result.bundle.prompts["TASK-DETECTION-PROMPT.md"]?.template).toContain("<<metadata>>");
    expect(result.bundle.prompts["tasks/qa.md"]?.template).toContain("<<text>>");
    expect(result.bundle.prompts["tasks/qa.md"]?.template).toContain("<<query>>");
    expect(result.bundle.prompts["filters/relevance.md"]?.template).toContain("<<preview>>");
    expect(result.bundle.prompts["reducers/select-relevant.md"]?.template).toContain("<<parts>>");
    expect(result.bundle.formalLeafSystemPrompt).toContain("bounded neural subroutine");
  });

  it("applies sparse global and project overlays file-by-file with project precedence and inheritance", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(
      homeDir,
      ".pi/lambda-rlm/prompts/tasks/qa.md",
      "GLOBAL QA <<query>> :: <<text>>",
    );
    await writeOverlay(
      homeDir,
      ".pi/lambda-rlm/prompts/FORMAL-LEAF-SYSTEM-PROMPT.md",
      "GLOBAL SYSTEM",
    );
    await writeOverlay(
      cwd,
      ".pi/lambda-rlm/prompts/tasks/qa.md",
      "PROJECT QA <<text>> / <<query>>",
    );
    await writeOverlay(
      cwd,
      ".pi/lambda-rlm/prompts/filters/relevance.md",
      "PROJECT FILTER <<query>> / <<preview>>",
    );

    const result = await resolvePromptBundle({ cwd, homeDir });

    expect(result.ok).toBeTruthy();
    if (!result.ok) {
      return;
    }
    expect(result.bundle.prompts["tasks/qa.md"]?.template).toBe("PROJECT QA <<text>> / <<query>>");
    expect(result.bundle.prompts["tasks/qa.md"]?.source.layer).toBe("project");
    expect(result.bundle.prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"]?.template).toBe("GLOBAL SYSTEM");
    expect(result.bundle.prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"]?.source.layer).toBe("global");
    expect(
      result.bundle.prompts["tasks/qa.md"]?.shadowedSources.map((source) => source.layer),
    ).toStrictEqual(["built_in", "global"]);
    expect(result.bundle.prompts["filters/relevance.md"]?.template).toBe(
      "PROJECT FILTER <<query>> / <<preview>>",
    );
    expect(result.bundle.prompts["reducers/select-relevant.md"]?.source.layer).toBe("built_in");
  });

  it("fails before execution on unknown placeholders and missing required placeholders", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwdUnknown = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(
      cwdUnknown,
      ".pi/lambda-rlm/prompts/tasks/qa.md",
      "Bad <<text>> <<query>> <<typo>>",
    );

    const unknown = await resolvePromptBundle({ cwd: cwdUnknown, homeDir });
    expect(unknown).toMatchObject({
      error: { code: "unknown_prompt_placeholder", field: "tasks/qa.md", type: "validation" },
      ok: false,
    });

    const cwdMissing = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(
      cwdMissing,
      ".pi/lambda-rlm/prompts/reducers/select-relevant.md",
      "Bad <<parts>> only",
    );

    const missing = await resolvePromptBundle({ cwd: cwdMissing, homeDir });
    expect(missing).toMatchObject({
      error: {
        code: "missing_required_prompt_placeholder",
        field: "reducers/select-relevant.md",
        type: "validation",
      },
      ok: false,
    });
  });

  it("rejects unknown runtime prompt files", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");
    await writeOverlay(cwd, ".pi/lambda-rlm/prompts/tasks/unknown.md", "unused");

    const result = await resolvePromptBundle({ cwd, homeDir });

    expect(result).toMatchObject({
      error: { code: "unknown_prompt_file", field: "tasks/unknown.md", type: "validation" },
      ok: false,
    });
  });

  it("ships copyable prompt templates but resolving prompts does not auto-seed runtime overlay directories", async () => {
    const homeDir = await tempRoot("lambda-rlm-home-");
    const cwd = await tempRoot("lambda-rlm-cwd-");

    await expect(
      stat(".pi/extensions/lambda-rlm/prompt-templates/tasks/qa.md"),
    ).resolves.toMatchObject({});
    await expect(
      stat(".pi/extensions/lambda-rlm/prompt-templates/FORMAL-LEAF-SYSTEM-PROMPT.md"),
    ).resolves.toMatchObject({});

    const result = await resolvePromptBundle({ cwd, homeDir });

    expect(result.ok).toBeTruthy();
    await expect(readdir(join(homeDir, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
