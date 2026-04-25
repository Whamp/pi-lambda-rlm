import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

function text(path: string) {
  return readFile(path, "utf-8");
}

async function expectFile(path: string) {
  await expect(stat(path)).resolves.toMatchObject({ isFile: expect.any(Function) });
}

describe("operator docs and examples", () => {
  it("documents the MVP operator contract without drifting into non-goals", async () => {
    const readme = await text("README.md");
    expect(readme).toContain("agent-invoked Pi tool");
    expect(readme).toContain("not a user command, provider, or benchmark harness");
    expect(readme).toContain("contextPath");
    expect(readme).toContain("contextPaths");
    expect(readme).toContain("question");
    expect(readme).toContain("no inline source or raw prompt");
    expect(readme).toContain("Context-budget invariant");
    expect(readme).toContain("config.toml");
    expect(readme).toContain("[run]");
    expect(readme).toContain("Prompt overlays");
    expect(readme).toContain("manual copy only");
    expect(readme).toContain("/lambda-rlm-doctor");
    expect(readme).toContain("npm run test:pi-leaf-smoke");
    expect(readme).toContain("cp .env.example .env");
    expect(readme).toContain("LAMBDA_RLM_LEAF_MODEL");
    expect(readme).toContain("MVP non-goals");
    expect(readme).toContain("Agentic Leaf Profiles");
    expect(readme).toContain("persistent workers");
    expect(readme).toContain("direct SDK completion");
    expect(readme).toContain("Pi session analysis");
    expect(readme).toContain("prompt optimization");
    expect(readme).not.toMatch(/JSON config/i);
    expect(readme).not.toMatch(/auto-seed/i);
  });

  it("ships reviewable examples for single-file QA, multi-file QA, and synthesis", async () => {
    const exampleFiles = [
      ".env.example",
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
