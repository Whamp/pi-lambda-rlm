import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type FormalLeafModelWriteKind =
  | "updated_existing_assignment"
  | "uncommented_scaffold_assignment"
  | "appended_to_existing_leaf_table"
  | "added_leaf_table";

export interface FormalLeafModelWriteResult {
  configPath: string;
  kind: FormalLeafModelWriteKind;
  model: string;
}

export interface FormalLeafModelWriteOptions {
  configPath: string;
  model: string;
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

function replaceLineValue(line: string, model: string, commented: boolean) {
  const ending = lineEnding(line);
  const body = ending ? line.slice(0, -ending.length) : line;
  const pattern = commented
    ? /^(\s*)#\s*model\s*=\s*(?:"(?:\\.|[^"])*"|'[^']*'|[^\s#]+)(\s+#.*)?$/
    : /^(\s*)model\s*=\s*(?:"(?:\\.|[^"])*"|'[^']*'|[^\s#]+)(\s+#.*)?$/;
  const match = body.match(pattern);
  if (!match) {
    return;
  }
  return `${match[1] ?? ""}model = ${quoteTomlString(model)}${match[2] ?? ""}${ending}`;
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

function editFormalLeafModel(text: string, model: string) {
  const lines = splitLinesPreservingEndings(text);
  const leafTable = findLeafTable(lines);
  if (!leafTable) {
    return {
      kind: "added_leaf_table" as const,
      text: `${text}${suffixBeforeNewLeafTable(text)}[leaf]\nmodel = ${quoteTomlString(model)}\n`,
    };
  }

  for (let index = leafTable.start + 1; index < leafTable.end; index += 1) {
    const replacement = replaceLineValue(lines[index] ?? "", model, false);
    if (replacement !== undefined) {
      lines[index] = replacement;
      return { kind: "updated_existing_assignment" as const, text: lines.join("") };
    }
  }

  for (let index = leafTable.start + 1; index < leafTable.end; index += 1) {
    const replacement = replaceLineValue(lines[index] ?? "", model, true);
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
  lines.splice(insertAt, 0, `model = ${quoteTomlString(model)}\n`);
  return { kind: "appended_to_existing_leaf_table" as const, text: lines.join("") };
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
  const edit = editFormalLeafModel(original, trimmedModel);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, edit.text, "utf-8");
  return { configPath, kind: edit.kind, model: trimmedModel };
}
