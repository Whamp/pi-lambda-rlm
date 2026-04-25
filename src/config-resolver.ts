import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RunConfig {
  maxInputBytes: number;
  outputMaxBytes: number;
  outputMaxLines: number;
  maxModelCalls: number;
  wholeRunTimeoutMs: number;
  modelCallTimeoutMs: number;
  modelProcessConcurrency: number;
}

export interface ConfigValidationError {
  type: "validation";
  code: string;
  message: string;
  field: string;
}

export type ConfigResult =
  | { ok: true; config: RunConfig }
  | { ok: false; error: ConfigValidationError };

export const DEFAULT_RUN_CONFIG: RunConfig = {
  maxInputBytes: 1_200_000,
  maxModelCalls: 1000,
  modelCallTimeoutMs: 60_000,
  modelProcessConcurrency: 2,
  outputMaxBytes: 51_200,
  outputMaxLines: 2000,
  wholeRunTimeoutMs: 300_000,
};

type Overlay = Partial<RunConfig>;
type PerRun = Partial<RunConfig>;

const TOML_TO_CONFIG: Record<string, keyof RunConfig> = {
  max_input_bytes: "maxInputBytes",
  max_model_calls: "maxModelCalls",
  model_call_timeout_ms: "modelCallTimeoutMs",
  model_process_concurrency: "modelProcessConcurrency",
  output_max_bytes: "outputMaxBytes",
  output_max_lines: "outputMaxLines",
  whole_run_timeout_ms: "wholeRunTimeoutMs",
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

export function parseConfigToml(
  toml: string,
  source: "global" | "project" = "global",
): { ok: true; overlay: Overlay } | { ok: false; error: ConfigValidationError } {
  const overlay: Overlay = {};
  let table: string | undefined;
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
      if (tableName === undefined) {
        continue;
      }
      table = tableName;
      if (table !== "run") {
        return {
          error: validationError(
            "unknown_config_key",
            `Unknown TOML table [${table}] in ${source} config. Only [run] is supported.`,
            `[${table}]`,
          ),
          ok: false,
        };
      }
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

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*([0-9]+)$/.exec(line);
    if (!assignment) {
      return {
        error: validationError(
          "invalid_toml",
          `Invalid TOML syntax in ${source} config at line ${lineNumber}. Expected [run] or key = positive_integer.`,
          `line ${lineNumber}`,
        ),
        ok: false,
      };
    }
    if (table !== "run") {
      return {
        error: validationError(
          "invalid_toml",
          `Config key ${assignment[1]} must be inside a [run] table.`,
          assignment[1] ?? `line ${lineNumber}`,
        ),
        ok: false,
      };
    }

    const tomlKey = assignment[1] ?? "";
    const configKey = TOML_TO_CONFIG[tomlKey];
    if (!configKey) {
      return {
        error: validationError(
          "unknown_config_key",
          `Unknown [run] key ${tomlKey}. Supported keys: max_input_bytes, output_max_bytes, output_max_lines, max_model_calls, whole_run_timeout_ms, model_call_timeout_ms, model_process_concurrency.`,
          `run.${tomlKey}`,
        ),
        ok: false,
      };
    }
    if (seenKeys.has(tomlKey)) {
      return {
        error: validationError(
          "invalid_toml",
          `Duplicate [run] key ${tomlKey} in ${source} config at line ${lineNumber}.`,
          `run.${tomlKey}`,
        ),
        ok: false,
      };
    }
    seenKeys.add(tomlKey);

    const value = Number(assignment[2]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      return {
        error: validationError(
          "invalid_config_value",
          `[run].${tomlKey} must be a positive safe integer.`,
          `run.${tomlKey}`,
        ),
        ok: false,
      };
    }
    overlay[configKey] = value;
  }

  return { ok: true, overlay };
}

function applyOverlay(base: RunConfig, overlay: Overlay): RunConfig {
  return { ...base, ...overlay };
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

export async function resolveRunConfig(
  args: {
    cwd?: string;
    homeDir?: string;
    globalConfigPath?: string;
    projectConfigPath?: string;
    perRun?: Record<string, unknown>;
  } = {},
): Promise<ConfigResult> {
  const cwd = args.cwd ?? process.cwd();
  const homeDir = args.homeDir ?? homedir();
  const globalConfigPath =
    args.globalConfigPath ?? join(homeDir, ".pi", "lambda-rlm", "config.toml");
  const projectConfigPath = args.projectConfigPath ?? join(cwd, ".pi", "lambda-rlm", "config.toml");

  let config = DEFAULT_RUN_CONFIG;
  for (const [source, path] of [
    ["global", globalConfigPath],
    ["project", projectConfigPath],
  ] as const) {
    const text = await readOptional(path);
    if (text === undefined) {
      continue;
    }
    const parsed = parseConfigToml(text, source);
    if (!parsed.ok) {
      return parsed;
    }
    config = applyOverlay(config, parsed.overlay);
  }

  const perRun = normalizePerRun(args.perRun);
  if (!perRun.ok) {
    return perRun;
  }
  for (const [field, value] of Object.entries(perRun.perRun) as [keyof RunConfig, number][]) {
    if (value > config[field]) {
      return {
        error: validationError(
          "per_run_limit_loosened",
          `${field}=${value} would loosen the resolved limit ${config[field]}. Per-run options may only tighten limits.`,
          field,
        ),
        ok: false,
      };
    }
    config = { ...config, [field]: value };
  }

  return { config, ok: true };
}
