import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptLayer = "built_in" | "global" | "project";

export interface PromptSource {
  layer: PromptLayer;
  path: string | null;
}

export interface ResolvedPrompt {
  template: string;
  source: PromptSource;
  shadowedSources: PromptSource[];
  bytes: number;
  sha256: string;
}

export interface ResolvedPromptBundle {
  version: 1;
  prompts: Record<string, ResolvedPrompt>;
  formalLeafSystemPrompt: string;
}

export interface PromptValidationError {
  type: "validation";
  code: string;
  message: string;
  field?: string;
}

export type PromptBundleResult =
  | { ok: true; bundle: ResolvedPromptBundle }
  | { ok: false; error: PromptValidationError };

interface PromptSpec {
  required: string[];
  allowed: string[];
}

export const PROMPT_SPECS: Record<string, PromptSpec> = {
  "FORMAL-LEAF-SYSTEM-PROMPT.md": { allowed: [], required: [] },
  "TASK-DETECTION-PROMPT.md": { allowed: ["metadata"], required: ["metadata"] },
  "filters/relevance.md": { allowed: ["query", "preview"], required: ["query", "preview"] },
  "reducers/combine-analysis.md": { allowed: ["parts", "query"], required: ["parts"] },
  "reducers/merge-summaries.md": { allowed: ["parts", "query"], required: ["parts"] },
  "reducers/select-relevant.md": { allowed: ["parts", "query"], required: ["parts", "query"] },
  "tasks/analysis.md": { allowed: ["text", "query"], required: ["text"] },
  "tasks/classification.md": { allowed: ["text", "query"], required: ["text"] },
  "tasks/extraction.md": { allowed: ["text", "query"], required: ["text"] },
  "tasks/general.md": { allowed: ["text", "query"], required: ["text"] },
  "tasks/qa.md": { allowed: ["text", "query"], required: ["text", "query"] },
  "tasks/summarization.md": { allowed: ["text", "query"], required: ["text"] },
  "tasks/translation.md": { allowed: ["text", "query"], required: ["text"] },
};

const PROMPT_KEYS = Object.keys(PROMPT_SPECS);
const PLACEHOLDER_RE = /<<([A-Za-z_][A-Za-z0-9_]*)>>/g;

export function promptKeys() {
  return [...PROMPT_KEYS];
}

export function defaultBuiltInPromptDir() {
  return fileURLToPath(new URL("../.pi/extensions/lambda-rlm/prompts", import.meta.url));
}

function sha256Hex(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function validation(code: string, message: string, field?: string): PromptBundleResult {
  return { error: { code, message, type: "validation", ...(field ? { field } : {}) }, ok: false };
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(path)));
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path);
      }
    }
    return files;
  }
  const absolute = await walk(root);
  return absolute.map((path) => relative(root, path).split(sep).join("/"));
}

function validatePlaceholders(key: string, template: string): PromptBundleResult | undefined {
  const spec = PROMPT_SPECS[key];
  if (!spec) {
    return validation("unknown_prompt_file", `Unknown prompt file: ${key}`, key);
  }
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const [, name] = match;
    if (!name) {
      continue;
    }
    found.add(name);
    if (!spec.allowed.includes(name)) {
      return validation(
        "unknown_prompt_placeholder",
        `Prompt ${key} uses unknown placeholder <<${name}>>.`,
        key,
      );
    }
  }
  for (const required of spec.required) {
    if (!found.has(required)) {
      return validation(
        "missing_required_prompt_placeholder",
        `Prompt ${key} is missing required placeholder <<${required}>>.`,
        key,
      );
    }
  }
  return undefined;
}

export async function resolvePromptBundle(
  options: {
    cwd?: string;
    homeDir?: string;
    builtInPromptDir?: string;
    globalPromptDir?: string;
    projectPromptDir?: string;
  } = {},
): Promise<PromptBundleResult> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd();
  const builtInPromptDir = options.builtInPromptDir ?? defaultBuiltInPromptDir();
  const globalPromptDir = options.globalPromptDir ?? join(homeDir, ".pi", "lambda-rlm", "prompts");
  const projectPromptDir = options.projectPromptDir ?? join(cwd, ".pi", "lambda-rlm", "prompts");

  for (const [layer, root] of [
    ["global", globalPromptDir],
    ["project", projectPromptDir],
  ] as const) {
    for (const file of await listMarkdownFiles(root)) {
      if (!PROMPT_SPECS[file]) {
        return validation(
          "unknown_prompt_file",
          `Unknown ${layer} prompt overlay file: ${file}`,
          file,
        );
      }
    }
  }

  const prompts: Record<string, ResolvedPrompt> = {};
  for (const key of PROMPT_KEYS) {
    const builtInPath = join(builtInPromptDir, key);
    const builtInTemplate = await readIfExists(builtInPath);
    if (builtInTemplate === undefined) {
      return validation("missing_built_in_prompt", `Missing built-in prompt default: ${key}`, key);
    }

    const candidates: { layer: PromptLayer; path: string | null; template: string }[] = [
      { layer: "built_in", path: builtInPath, template: builtInTemplate },
    ];
    const globalPath = join(globalPromptDir, key);
    const globalTemplate = await readIfExists(globalPath);
    if (globalTemplate !== undefined) {
      candidates.push({ layer: "global", path: globalPath, template: globalTemplate });
    }
    const projectPath = join(projectPromptDir, key);
    const projectTemplate = await readIfExists(projectPath);
    if (projectTemplate !== undefined) {
      candidates.push({ layer: "project", path: projectPath, template: projectTemplate });
    }

    const selected = candidates.at(-1);
    if (!selected) {
      return validation("missing_built_in_prompt", `Missing built-in prompt default: ${key}`, key);
    }
    const invalid = validatePlaceholders(key, selected.template);
    if (invalid) {
      return invalid;
    }
    prompts[key] = {
      bytes: Buffer.byteLength(selected.template, "utf-8"),
      sha256: sha256Hex(selected.template),
      shadowedSources: candidates
        .slice(0, -1)
        .map((candidate) => ({ layer: candidate.layer, path: candidate.path })),
      source: { layer: selected.layer, path: selected.path },
      template: selected.template,
    };
  }

  const formalLeafSystemPrompt = prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"];
  if (!formalLeafSystemPrompt) {
    return validation(
      "missing_built_in_prompt",
      "Missing built-in prompt default: FORMAL-LEAF-SYSTEM-PROMPT.md",
      "FORMAL-LEAF-SYSTEM-PROMPT.md",
    );
  }

  return {
    bundle: {
      formalLeafSystemPrompt: formalLeafSystemPrompt.template,
      prompts,
      version: 1,
    },
    ok: true,
  };
}
