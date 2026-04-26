import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RunConfig {
  maxInputBytes: number;
  outputMaxBytes: number;
  outputMaxLines: number;
  maxModelCalls: number;
  wholeRunTimeoutMs: number;
  modelCallTimeoutMs: number;
  modelProcessConcurrency: number;
}

export type LeafThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface LeafConfig {
  /** Pi model pattern passed to child `pi --model`, normally `<provider>/<model-id>`. */
  model?: string;
  /** Pi executable used for Formal Leaf child calls. */
  piExecutable: string;
  /** Thinking level passed to child `pi --thinking`. */
  thinking: LeafThinking;
}

export interface LambdaRlmConfig {
  run: RunConfig;
  leaf: LeafConfig;
}

export interface ConfigValidationError {
  type: "validation";
  code: string;
  message: string;
  field: string;
}

export type ConfigResult<T = RunConfig> =
  | { ok: true; config: T }
  | { ok: false; error: ConfigValidationError };

export type ConfigSource = "default" | "global" | "project";

export interface LambdaRlmConfigSourceReport {
  paths: { global: string; project: string };
  exists: { global: boolean; project: boolean };
  leaf: { model: ConfigSource };
}

export type ConfigWithSourcesResult = ConfigResult<{
  config: LambdaRlmConfig;
  sources: LambdaRlmConfigSourceReport;
}>;

export const DEFAULT_RUN_CONFIG: RunConfig = {
  maxInputBytes: 1_200_000,
  maxModelCalls: 1000,
  modelCallTimeoutMs: 60_000,
  modelProcessConcurrency: 2,
  outputMaxBytes: 51_200,
  outputMaxLines: 2000,
  wholeRunTimeoutMs: 300_000,
};

export const DEFAULT_LEAF_CONFIG: LeafConfig = {
  piExecutable: "pi",
  thinking: "off",
};

type RunOverlay = Partial<RunConfig>;
type LeafOverlay = Partial<LeafConfig>;
interface LambdaRlmOverlay {
  run: RunOverlay;
  leaf: LeafOverlay;
}
type PerRun = Partial<RunConfig>;

const TOML_TO_RUN_CONFIG: Record<string, keyof RunConfig> = {
  max_input_bytes: "maxInputBytes",
  max_model_calls: "maxModelCalls",
  model_call_timeout_ms: "modelCallTimeoutMs",
  model_process_concurrency: "modelProcessConcurrency",
  output_max_bytes: "outputMaxBytes",
  output_max_lines: "outputMaxLines",
  whole_run_timeout_ms: "wholeRunTimeoutMs",
};

const TOML_TO_LEAF_CONFIG: Record<string, keyof LeafConfig> = {
  model: "model",
  pi_executable: "piExecutable",
  thinking: "thinking",
};

const CONFIG_FIELDS = new Set<keyof RunConfig>([
  "maxInputBytes",
  "outputMaxBytes",
  "outputMaxLines",
  "maxModelCalls",
  "wholeRunTimeoutMs",
  "modelCallTimeoutMs",
  "modelProcessConcurrency",
]);

const LEAF_THINKING_VALUES = new Set<LeafThinking>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function validationError(code: string, message: string, field: string): ConfigValidationError {
  return { code, field, message, type: "validation" };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function stripComment(line: string) {
  const hash = line.indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function parseStringValue(raw: string, source: "global" | "project", lineNumber: number) {
  const match = /^"([^"]*)"$/.exec(raw.trim());
  if (!match) {
    return {
      error: validationError(
        "invalid_toml",
        `Invalid TOML syntax in ${source} config at line ${lineNumber}. Expected a quoted string value.`,
        `line ${lineNumber}`,
      ),
      ok: false as const,
    };
  }
  return { ok: true as const, value: match[1] ?? "" };
}

function parsePositiveIntegerValue(
  raw: string,
  source: "global" | "project",
  lineNumber: number,
  field: string,
) {
  if (!/^[0-9]+$/.test(raw.trim())) {
    return {
      error: validationError(
        "invalid_toml",
        `Invalid TOML syntax in ${source} config at line ${lineNumber}. Expected ${field} = positive_integer for [run] values.`,
        `run.${field}`,
      ),
      ok: false as const,
    };
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      error: validationError(
        "invalid_config_value",
        `[run].${field} must be a positive safe integer.`,
        `run.${field}`,
      ),
      ok: false as const,
    };
  }
  return { ok: true as const, value };
}

function parseRunAssignment(args: {
  key: string;
  rawValue: string;
  source: "global" | "project";
  lineNumber: number;
  overlay: LambdaRlmOverlay;
}) {
  const configKey = TOML_TO_RUN_CONFIG[args.key];
  if (!configKey) {
    return {
      error: validationError(
        "unknown_config_key",
        `Unknown [run] key ${args.key}. Supported keys: max_input_bytes, output_max_bytes, output_max_lines, max_model_calls, whole_run_timeout_ms, model_call_timeout_ms, model_process_concurrency.`,
        `run.${args.key}`,
      ),
      ok: false as const,
    };
  }

  const parsed = parsePositiveIntegerValue(args.rawValue, args.source, args.lineNumber, args.key);
  if (!parsed.ok) {
    return parsed;
  }
  args.overlay.run[configKey] = parsed.value;
  return { ok: true as const };
}

function parseLeafAssignment(args: {
  key: string;
  rawValue: string;
  source: "global" | "project";
  lineNumber: number;
  overlay: LambdaRlmOverlay;
}) {
  const configKey = TOML_TO_LEAF_CONFIG[args.key];
  if (!configKey) {
    return {
      error: validationError(
        "unknown_config_key",
        `Unknown [leaf] key ${args.key}. Supported keys: model, thinking, pi_executable.`,
        `leaf.${args.key}`,
      ),
      ok: false as const,
    };
  }

  const parsed = parseStringValue(args.rawValue, args.source, args.lineNumber);
  if (!parsed.ok) {
    return parsed;
  }
  const value = parsed.value.trim();
  if (!value) {
    return {
      error: validationError(
        "invalid_config_value",
        `[leaf].${args.key} must be a non-empty string.`,
        `leaf.${args.key}`,
      ),
      ok: false as const,
    };
  }
  if (configKey === "thinking" && !LEAF_THINKING_VALUES.has(value as LeafThinking)) {
    return {
      error: validationError(
        "invalid_config_value",
        `[leaf].thinking must be one of: off, minimal, low, medium, high, xhigh.`,
        "leaf.thinking",
      ),
      ok: false as const,
    };
  }
  args.overlay.leaf[configKey] = value as never;
  return { ok: true as const };
}

export function parseConfigToml(
  toml: string,
  source: "global" | "project" = "global",
): { ok: true; overlay: LambdaRlmOverlay } | { ok: false; error: ConfigValidationError } {
  const overlay: LambdaRlmOverlay = { leaf: {}, run: {} };
  let table: "run" | "leaf" | undefined;
  const seenTables = new Set<string>();
  const seenKeys = new Set<string>();
  const lines = toml.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(lines[index] ?? "");
    if (!line) {
      continue;
    }

    const tableMatch = /^\[([A-Za-z0-9_-]+)]$/.exec(line);
    if (tableMatch) {
      const [, tableName] = tableMatch;
      if (tableName !== "run" && tableName !== "leaf") {
        return {
          error: validationError(
            "unknown_config_key",
            `Unknown TOML table [${tableName}] in ${source} config. Only [run] and [leaf] are supported.`,
            `[${tableName}]`,
          ),
          ok: false,
        };
      }
      table = tableName;
      if (seenTables.has(table)) {
        return {
          error: validationError(
            "invalid_toml",
            `Duplicate TOML table [${table}] in ${source} config at line ${lineNumber}.`,
            `[${table}]`,
          ),
          ok: false,
        };
      }
      seenTables.add(table);
      continue;
    }

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) {
      return {
        error: validationError(
          "invalid_toml",
          `Invalid TOML syntax in ${source} config at line ${lineNumber}. Expected [run], [leaf], or key = value.`,
          `line ${lineNumber}`,
        ),
        ok: false,
      };
    }
    if (!table) {
      return {
        error: validationError(
          "invalid_toml",
          `Config key ${assignment[1]} must be inside a [run] or [leaf] table.`,
          assignment[1] ?? `line ${lineNumber}`,
        ),
        ok: false,
      };
    }

    const tomlKey = assignment[1] ?? "";
    const seenKey = `${table}.${tomlKey}`;
    if (seenKeys.has(seenKey)) {
      return {
        error: validationError(
          "invalid_toml",
          `Duplicate [${table}] key ${tomlKey} in ${source} config at line ${lineNumber}.`,
          `${table}.${tomlKey}`,
        ),
        ok: false,
      };
    }
    seenKeys.add(seenKey);

    const rawValue = assignment[2] ?? "";
    const parsed =
      table === "run"
        ? parseRunAssignment({ key: tomlKey, lineNumber, overlay, rawValue, source })
        : parseLeafAssignment({ key: tomlKey, lineNumber, overlay, rawValue, source });
    if (!parsed.ok) {
      return parsed;
    }
  }

  return { ok: true, overlay };
}

function applyOverlay(base: LambdaRlmConfig, overlay: LambdaRlmOverlay): LambdaRlmConfig {
  return {
    leaf: { ...base.leaf, ...overlay.leaf },
    run: { ...base.run, ...overlay.run },
  };
}

function normalizePerRun(
  perRun: Record<string, unknown> | undefined,
): { ok: true; perRun: PerRun } | { ok: false; error: ConfigValidationError } {
  const out: PerRun = {};
  if (!perRun) {
    return { ok: true, perRun: out };
  }

  for (const [field, raw] of Object.entries(perRun)) {
    if (!CONFIG_FIELDS.has(field as keyof RunConfig)) {
      continue;
    }
    if (!Number.isSafeInteger(raw) || (raw as number) <= 0) {
      return {
        error: validationError(
          "invalid_config_value",
          `${field} must be a positive safe integer.`,
          field,
        ),
        ok: false,
      };
    }
    out[field as keyof RunConfig] = raw as number;
  }
  return { ok: true, perRun: out };
}

function configPaths(args: {
  cwd?: string;
  homeDir?: string;
  globalConfigPath?: string;
  projectConfigPath?: string;
}) {
  const cwd = args.cwd ?? process.cwd();
  const homeDir = args.homeDir ?? homedir();
  return {
    globalConfigPath: args.globalConfigPath ?? join(homeDir, ".pi", "lambda-rlm", "config.toml"),
    projectConfigPath: args.projectConfigPath ?? join(cwd, ".pi", "lambda-rlm", "config.toml"),
  };
}

export async function resolveLambdaRlmConfigWithSources(
  args: {
    cwd?: string;
    homeDir?: string;
    globalConfigPath?: string;
    projectConfigPath?: string;
    perRun?: Record<string, unknown>;
  } = {},
): Promise<ConfigWithSourcesResult> {
  const { globalConfigPath, projectConfigPath } = configPaths(args);
  const exists = { global: false, project: false };
  const sources: LambdaRlmConfigSourceReport = {
    exists,
    leaf: { model: "default" },
    paths: { global: globalConfigPath, project: projectConfigPath },
  };

  let config: LambdaRlmConfig = { leaf: DEFAULT_LEAF_CONFIG, run: DEFAULT_RUN_CONFIG };
  const configLayers = [
    ["global", globalConfigPath],
    ...(resolve(projectConfigPath) === resolve(globalConfigPath)
      ? []
      : [["project", projectConfigPath] as const]),
  ] as const;

  for (const [source, path] of configLayers) {
    const text = await readOptional(path);
    if (text === undefined) {
      continue;
    }
    exists[source] = true;
    const parsed = parseConfigToml(text, source);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.overlay.leaf.model) {
      sources.leaf.model = source;
    }
    config = applyOverlay(config, parsed.overlay);
  }

  const perRun = normalizePerRun(args.perRun);
  if (!perRun.ok) {
    return perRun;
  }
  for (const [field, value] of Object.entries(perRun.perRun) as [keyof RunConfig, number][]) {
    if (value > config.run[field]) {
      return {
        error: validationError(
          "per_run_limit_loosened",
          `${field}=${value} would loosen the resolved limit ${config.run[field]}. Per-run options may only tighten limits.`,
          field,
        ),
        ok: false,
      };
    }
    config = { ...config, run: { ...config.run, [field]: value } };
  }

  return { config: { config, sources }, ok: true };
}

export async function resolveLambdaRlmConfig(
  args: {
    cwd?: string;
    homeDir?: string;
    globalConfigPath?: string;
    projectConfigPath?: string;
    perRun?: Record<string, unknown>;
  } = {},
): Promise<ConfigResult<LambdaRlmConfig>> {
  const result = await resolveLambdaRlmConfigWithSources(args);
  if (!result.ok) {
    return result;
  }
  return { config: result.config.config, ok: true };
}

export async function resolveRunConfig(
  args: {
    cwd?: string;
    homeDir?: string;
    globalConfigPath?: string;
    projectConfigPath?: string;
    perRun?: Record<string, unknown>;
  } = {},
): Promise<ConfigResult<RunConfig>> {
  const result = await resolveLambdaRlmConfig(args);
  if (!result.ok) {
    return result;
  }
  return { config: result.config.run, ok: true };
}
