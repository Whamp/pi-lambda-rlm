import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function text(path: string) {
  return readFile(path, "utf-8");
}

async function expectFile(path: string) {
  await expect(stat(path)).resolves.toMatchObject({ isFile: expect.any(Function) });
}

describe("operator docs and examples", () => {
  it("documents the user onboarding contract before development details", async () => {
    const readme = await text("README.md");
    expect(readme).toContain("agent-invoked Pi tool");
    expect(readme).toContain("not a provider or benchmark harness");
    expect(readme).toContain("pi install");
    expect(readme).toContain("/reload");
    expect(readme).toContain("~/.pi/lambda-rlm/config.toml");
    expect(readme).toContain("[leaf]");
    expect(readme).toContain('model = "');
    expect(readme).toContain("~/.pi/agent/models.json");
    expect(readme).toContain("~/.pi/agent/auth.json");
    expect(readme).toContain("/login");
    expect(readme).toContain("/lambda-rlm-doctor");
    expect(readme).toContain("contextPath");
    expect(readme).toContain("contextPaths");
    expect(readme).toContain("question");
    expect(readme).toContain("no inline source or raw prompt");
    expect(readme).toContain("[run]");
    expect(readme).toContain("Prompt overlays");
    expect(readme).toContain("manual copy only");
    expect(readme).toContain("Development notes");
    expect(readme).toContain("npm test");
    expect(readme).not.toContain(".env.example");
    expect(readme).not.toContain("LAMBDA_RLM_LEAF_MODEL");
    expect(readme).toContain("MVP non-goals");
    expect(readme).not.toMatch(/JSON config/i);
    expect(readme).not.toMatch(/auto-seed/i);
  });

  it("declares a Pi package manifest for global pi install", async () => {
    const pkg = JSON.parse(await text("package.json")) as {
      private?: boolean;
      keywords?: string[];
      pi?: { extensions?: string[] };
      files?: string[];
    };

    expect(pkg.private).not.toBeTruthy();
    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi?.extensions).toContain(".pi/extensions/lambda-rlm/index.ts");
    expect(pkg.files).toStrictEqual(
      expect.arrayContaining([
        "src/",
        "README.md",
        ".pi/extensions/lambda-rlm/index.ts",
        ".pi/extensions/lambda-rlm/bridge.py",
        ".pi/extensions/lambda-rlm/prompts/",
        ".pi/extensions/lambda-rlm/rlm/**/*.py",
      ]),
    );
  });

  it("ships reviewable examples for single-file QA, multi-file QA, and synthesis", async () => {
    const exampleFiles = [
      "examples/single-file-qa/README.md",
      "examples/single-file-qa/context.md",
      "examples/multi-file-qa/README.md",
      "examples/multi-file-qa/design.md",
      "examples/multi-file-qa/ops.md",
      "examples/synthesis/README.md",
      "examples/synthesis/research-a.md",
      "examples/synthesis/research-b.md",
      "docs/manual-review-checkpoint.md",
      "docs/future-work.md",
    ];
    await Promise.all(exampleFiles.map(expectFile));
    const single = await text("examples/single-file-qa/README.md");
    expect(single).toContain("contextPath");
    expect(single).toContain("question");
    const multi = await text("examples/multi-file-qa/README.md");
    expect(multi).toContain("contextPaths");
    expect(multi).toContain("multi-file QA");
    const synthesis = await text("examples/synthesis/README.md");
    expect(synthesis).toContain("long-context synthesis");
    expect(synthesis).toContain("contextPaths");
    const review = await text("docs/manual-review-checkpoint.md");
    expect(review).toContain("usefulness");
    expect(review).toContain("boundedness");
    expect(review).toContain("clarity");
    expect(review).toContain("Reviewed");
  });
});
