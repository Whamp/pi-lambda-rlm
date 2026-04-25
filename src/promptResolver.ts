import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PromptLayer = "built_in" | "global" | "project";

export type PromptSource = {
  layer: PromptLayer;
  path: string | null;
};

export type ResolvedPrompt = {
  template: string;
  source: PromptSource;
  shadowedSources: PromptSource[];
  bytes: number;
  sha256: string;
};

export type ResolvedPromptBundle = {
  version: 1;
  prompts: Record<string, ResolvedPrompt>;
  formalLeafSystemPrompt: string;
};

export type PromptValidationError = {
  type: "validation";
  code: string;
  message: string;
  field?: string;
};

export type PromptBundleResult = { ok: true; bundle: ResolvedPromptBundle } | { ok: false; error: PromptValidationError };

type PromptSpec = { required: string[]; allowed: string[] };

export const PROMPT_SPECS: Record<string, PromptSpec> = {
  "FORMAL-LEAF-SYSTEM-PROMPT.md": { required: [], allowed: [] },
  "TASK-DETECTION-PROMPT.md": { required: ["metadata"], allowed: ["metadata"] },
  "tasks/summarization.md": { required: ["text"], allowed: ["text", "query"] },
  "tasks/qa.md": { required: ["text", "query"], allowed: ["text", "query"] },
  "tasks/translation.md": { required: ["text"], allowed: ["text", "query"] },
  "tasks/classification.md": { required: ["text"], allowed: ["text", "query"] },
  "tasks/extraction.md": { required: ["text"], allowed: ["text", "query"] },
  "tasks/analysis.md": { required: ["text"], allowed: ["text", "query"] },
  "tasks/general.md": { required: ["text"], allowed: ["text", "query"] },
  "filters/relevance.md": { required: ["query", "preview"], allowed: ["query", "preview"] },
  "reducers/merge-summaries.md": { required: ["parts"], allowed: ["parts", "query"] },
  "reducers/select-relevant.md": { required: ["parts", "query"], allowed: ["parts", "query"] },
  "reducers/combine-analysis.md": { required: ["parts"], allowed: ["parts", "query"] },
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
  return { ok: false, error: { type: "validation", code, message, ...(field ? { field } : {}) } };
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(path)));
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
    return files;
  }
  const absolute = await walk(root);
  return absolute.map((path) => relative(root, path).split(sep).join("/"));
}

function validatePlaceholders(key: string, template: string): PromptBundleResult | undefined {
  const spec = PROMPT_SPECS[key];
  if (!spec) return validation("unknown_prompt_file", `Unknown prompt file: ${key}`, key);
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const name = match[1]!;
    found.add(name);
    if (!spec.allowed.includes(name)) {
      return validation("unknown_prompt_placeholder", `Prompt ${key} uses unknown placeholder <<${name}>>.`, key);
    }
  }
  for (const required of spec.required) {
    if (!found.has(required)) {
      return validation("missing_required_prompt_placeholder", `Prompt ${key} is missing required placeholder <<${required}>>.`, key);
    }
  }
  return undefined;
}

export async function resolvePromptBundle(options: {
  cwd?: string;
  homeDir?: string;
  builtInPromptDir?: string;
  globalPromptDir?: string;
  projectPromptDir?: string;
} = {}): Promise<PromptBundleResult> {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? process.env.HOME ?? process.cwd();
  const builtInPromptDir = options.builtInPromptDir ?? defaultBuiltInPromptDir();
  const globalPromptDir = options.globalPromptDir ?? join(homeDir, ".pi", "lambda-rlm", "prompts");
  const projectPromptDir = options.projectPromptDir ?? join(cwd, ".pi", "lambda-rlm", "prompts");

  for (const [layer, root] of [["global", globalPromptDir], ["project", projectPromptDir]] as const) {
    for (const file of await listMarkdownFiles(root)) {
      if (!PROMPT_SPECS[file]) return validation("unknown_prompt_file", `Unknown ${layer} prompt overlay file: ${file}`, file);
    }
  }

  const prompts: Record<string, ResolvedPrompt> = {};
  for (const key of PROMPT_KEYS) {
    const builtInPath = join(builtInPromptDir, key);
    const builtInTemplate = await readIfExists(builtInPath);
    if (builtInTemplate === undefined) return validation("missing_built_in_prompt", `Missing built-in prompt default: ${key}`, key);

    const candidates: Array<{ layer: PromptLayer; path: string | null; template: string }> = [
      { layer: "built_in", path: builtInPath, template: builtInTemplate },
    ];
    const globalPath = join(globalPromptDir, key);
    const globalTemplate = await readIfExists(globalPath);
    if (globalTemplate !== undefined) candidates.push({ layer: "global", path: globalPath, template: globalTemplate });
    const projectPath = join(projectPromptDir, key);
    const projectTemplate = await readIfExists(projectPath);
    if (projectTemplate !== undefined) candidates.push({ layer: "project", path: projectPath, template: projectTemplate });

    const selected = candidates[candidates.length - 1]!;
    const invalid = validatePlaceholders(key, selected.template);
    if (invalid) return invalid;
    prompts[key] = {
      template: selected.template,
      source: { layer: selected.layer, path: selected.path },
      shadowedSources: candidates.slice(0, -1).map((candidate) => ({ layer: candidate.layer, path: candidate.path })),
      bytes: Buffer.byteLength(selected.template, "utf8"),
      sha256: sha256Hex(selected.template),
    };
  }

  return {
    ok: true,
    bundle: {
      version: 1,
      prompts,
      formalLeafSystemPrompt: prompts["FORMAL-LEAF-SYSTEM-PROMPT.md"]!.template,
    },
  };
}
