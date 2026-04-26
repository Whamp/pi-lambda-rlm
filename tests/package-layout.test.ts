import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultLambdaRlmBridgePath } from "../src/lambda-rlm-tool.js";
import { defaultBuiltInPromptDir } from "../src/prompt-resolver.js";

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("installed package layout", () => {
  it("declares the extension from the package extensions directory, not project-local .pi auto-discovery", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf-8")) as {
      files?: string[];
      pi?: { extensions?: string[] };
    };

    expect(manifest.pi?.extensions).toStrictEqual(["extensions/lambda-rlm/index.ts"]);
    expect(manifest.files).toStrictEqual(
      expect.arrayContaining(["src/", "extensions/lambda-rlm/"]),
    );
    expect(manifest.files?.some((entry) => entry.startsWith(".pi/extensions/"))).toBeFalsy();
    await expect(stat("extensions/lambda-rlm/index.ts")).resolves.toMatchObject({});
    await expect(exists(".pi/extensions/lambda-rlm/index.ts")).resolves.toBeFalsy();
  });

  it("resolves bundled runtime assets from the package extension directory", async () => {
    const extensionRoot = join(process.cwd(), "extensions", "lambda-rlm");

    expect(defaultBuiltInPromptDir()).toBe(join(extensionRoot, "prompts"));
    expect(defaultLambdaRlmBridgePath()).toBe(join(extensionRoot, "bridge.py"));
    await expect(
      stat(join(extensionRoot, "prompt-templates", "tasks", "qa.md")),
    ).resolves.toMatchObject({});
    await expect(stat(join(extensionRoot, "rlm", "lambda_rlm.py"))).resolves.toMatchObject({});
  });
});
