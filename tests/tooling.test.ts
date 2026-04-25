import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readText = (path: string) => readFile(path, "utf-8");
const readJson = async <T>(path: string) => JSON.parse(await readText(path)) as T;

interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe("project linting tooling", () => {
  it("exposes Ultracite lint scripts backed by Oxlint and Oxfmt", async () => {
    const packageJson = await readJson<PackageJson>("package.json");

    expect(packageJson.scripts).toMatchObject({
      lint: "ultracite check",
      "lint:fix": "ultracite fix",
    });
    expect(packageJson.devDependencies).toMatchObject({
      oxfmt: expect.any(String),
      oxlint: expect.any(String),
      ultracite: expect.any(String),
    });
  });

  it("uses Ultracite's Oxlint and Oxfmt presets", async () => {
    await expect(readText("oxlint.config.ts")).resolves.toContain("ultracite/oxlint/core");
    await expect(readText("oxlint.config.ts")).resolves.toContain("ultracite/oxlint/vitest");
    await expect(readText("oxfmt.config.ts")).resolves.toContain("ultracite/oxfmt");
  });
});
