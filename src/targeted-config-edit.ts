import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  LEAF_THINKING_VALUES,
  LEAF_THINKING_VALUE_SET,
  parseConfigToml,
} from "./config-resolver.js";
import type { LeafThinking } from "./config-resolver.js";
import { TRANSPARENT_SPARSE_CONFIG_SCAFFOLD } from "./workspace-scaffolding.js";

export type TargetedLeafSettingWriteKind =
  | "updated_existing_assignment"
  | "uncommented_scaffold_assignment"
  | "appended_to_existing_leaf_table"
  | "added_leaf_table";

export type FormalLeafModelWriteKind = TargetedLeafSettingWriteKind;

export interface FormalLeafModelWriteResult {
  configPath: string;
  kind: FormalLeafModelWriteKind;
  model: string;
}

export interface FormalLeafThinkingWriteResult {
  configPath: string;
  kind: TargetedLeafSettingWriteKind;
  thinking: LeafThinking;
}

export interface FormalLeafModelWriteOptions {
  configPath: string;
  model: string;
}

export interface FormalLeafThinkingWriteOptions {
  configPath: string;
  thinking: LeafThinking;
}

export interface NormalizedRewriteOptions {
  configPath: string;
  confirmed: boolean;
}

export type NormalizedRewriteResult =
  | { configPath: string; rewritten: false }
  | { backupPath: string; configPath: string; rewritten: true };

export class UnsafeConfigEditError extends Error {
  code = "unsafe_config_edit";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeConfigEditError";
  }
}

function quoteTomlString(value: string) {
  return JSON.stringify(value);
}

async function readConfigIfPresent(configPath: string) {
  try {
    return await readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function splitLinesPreservingEndings(text: string) {
  const matches = text.match(/.*(?:\r?\n|$)/g) ?? [];
  return matches.filter((line, index) => line.length > 0 || index < matches.length - 1);
}

function lineEnding(line: string) {
  if (line.endsWith("\r\n")) {
    return "\r\n";
  }
  if (line.endsWith("\n")) {
    return "\n";
  }
  return "";
}

function replaceLineValue(
  line: string,
  key: "model" | "thinking",
  value: string,
  commented: boolean,
) {
  const ending = lineEnding(line);
  const body = ending ? line.slice(0, -ending.length) : line;
  const escapedKey = key.replaceAll(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  const pattern = new RegExp(
    commented
      ? `^(\\s*)#\\s*${escapedKey}\\s*=\\s*(?:"(?:\\\\.|[^"])*"|'[^']*'|[^\\s#]+)(\\s+#.*)?$`
      : `^(\\s*)${escapedKey}\\s*=\\s*(?:"(?:\\\\.|[^"])*"|'[^']*'|[^\\s#]+)(\\s+#.*)?$`,
  );
  const match = body.match(pattern);
  if (!match) {
    return;
  }
  return `${match[1] ?? ""}${key} = ${quoteTomlString(value)}${match[2] ?? ""}${ending}`;
}

function findLeafTable(lines: string[]) {
  const start = lines.findIndex((line) => /^\s*\[leaf\]\s*(?:#.*)?(?:\r?\n)?$/.test(line));
  if (start === -1) {
    return;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?(?:\r?\n)?$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  return { end, start };
}

function suffixBeforeNewLeafTable(text: string) {
  if (text.length === 0) {
    return "";
  }
  if (text.endsWith("\n")) {
    return "\n";
  }
  return "\n\n";
}

function editFormalLeafSetting(text: string, key: "model" | "thinking", value: string) {
  const lines = splitLinesPreservingEndings(text);
  const leafTable = findLeafTable(lines);
  if (!leafTable) {
    return {
      kind: "added_leaf_table" as const,
      text: `${text}${suffixBeforeNewLeafTable(text)}[leaf]\n${key} = ${quoteTomlString(value)}\n`,
    };
  }

  for (let index = leafTable.start + 1; index < leafTable.end; index += 1) {
    const replacement = replaceLineValue(lines[index] ?? "", key, value, false);
    if (replacement !== undefined) {
      lines[index] = replacement;
      return { kind: "updated_existing_assignment" as const, text: lines.join("") };
    }
  }

  for (let index = leafTable.start + 1; index < leafTable.end; index += 1) {
    const replacement = replaceLineValue(lines[index] ?? "", key, value, true);
    if (replacement !== undefined) {
      lines[index] = replacement;
      return { kind: "uncommented_scaffold_assignment" as const, text: lines.join("") };
    }
  }

  let insertAt = leafTable.end;
  while (insertAt > leafTable.start + 1 && /^\s*$/.test(lines[insertAt - 1] ?? "")) {
    insertAt -= 1;
  }
  if (insertAt > 0 && lineEnding(lines[insertAt - 1] ?? "") === "") {
    lines[insertAt - 1] = `${lines[insertAt - 1] ?? ""}\n`;
  }
  lines.splice(insertAt, 0, `${key} = ${quoteTomlString(value)}\n`);
  return { kind: "appended_to_existing_leaf_table" as const, text: lines.join("") };
}

function assertStructurallySafeConfig(text: string) {
  if (!text.trim()) {
    return;
  }
  const parsed = parseConfigToml(text);
  if (!parsed.ok) {
    throw new UnsafeConfigEditError(
      `Targeted Config Edit is blocked because the Tool Configuration File is structurally unsafe to edit: ${parsed.error.message}`,
    );
  }
}

function timestampForBackup() {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

export async function writeFormalLeafModelSelection({
  configPath,
  model,
}: FormalLeafModelWriteOptions): Promise<FormalLeafModelWriteResult> {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    throw new Error("Formal Leaf model must be a non-empty string.");
  }
  const original = await readConfigIfPresent(configPath);
  assertStructurallySafeConfig(original);
  const edit = editFormalLeafSetting(original, "model", trimmedModel);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, edit.text, "utf-8");
  return { configPath, kind: edit.kind, model: trimmedModel };
}

export async function writeFormalLeafThinkingSelection({
  configPath,
  thinking,
}: FormalLeafThinkingWriteOptions): Promise<FormalLeafThinkingWriteResult> {
  if (!LEAF_THINKING_VALUE_SET.has(thinking)) {
    throw new Error(`Formal Leaf thinking must be one of: ${LEAF_THINKING_VALUES.join(", ")}.`);
  }
  const original = await readConfigIfPresent(configPath);
  assertStructurallySafeConfig(original);
  const edit = editFormalLeafSetting(original, "thinking", thinking);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, edit.text, "utf-8");
  return { configPath, kind: edit.kind, thinking };
}

export async function normalizeRewriteInvalidConfig({
  configPath,
  confirmed,
}: NormalizedRewriteOptions): Promise<NormalizedRewriteResult> {
  if (!confirmed) {
    return { configPath, rewritten: false };
  }
  const original = await readConfigIfPresent(configPath);
  await mkdir(dirname(configPath), { recursive: true });
  const backupPath = `${configPath}.invalid.${timestampForBackup()}.bak`;
  await writeFile(backupPath, original, "utf-8");
  await writeFile(configPath, TRANSPARENT_SPARSE_CONFIG_SCAFFOLD, "utf-8");
  return { backupPath, configPath, rewritten: true };
}
