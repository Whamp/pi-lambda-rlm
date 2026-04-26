import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export interface WorkspaceScaffoldingOptions {
  workspacePath?: string;
}

export interface WorkspaceScaffoldingResult {
  createdDirectories: string[];
  createdFiles: string[];
  createdWorkspace: boolean;
}

const EXAMPLE_FIXTURE_ROOT = "examples";
const PACKAGE_EXAMPLES_DIR = join(import.meta.dirname, "..", EXAMPLE_FIXTURE_ROOT);

export function defaultLambdaRlmUserWorkspacePath() {
  return join(homedir(), ".pi", "lambda-rlm");
}

export const TRANSPARENT_SPARSE_CONFIG_SCAFFOLD = `[leaf]
# Add a Formal Leaf model manually before real Lambda-RLM runs.
# Use a model accepted by Pi, for example: model = "<provider>/<model-id>"
# model = "<provider>/<model-id>"
thinking = "off"
pi_executable = "pi"

[run]
# Built-in Run Control Policy defaults are documented here as comments.
# Uncomment only values you intentionally want to override.
# max_input_bytes = 1200000
# output_max_bytes = 51200
# output_max_lines = 2000
# max_model_calls = 1000
# whole_run_timeout_ms = 300000
# model_call_timeout_ms = 60000
# model_process_concurrency = 2
`;

const WORKSPACE_README = `# Lambda-RLM User Workspace

This directory is the global Lambda-RLM User Workspace. Workspace Scaffolding creates it on extension load so setup is visible and recoverable.

Next steps:

1. Inspect \`config.toml\` and the Copied Example Fixtures under \`examples/\`.
2. Run \`/lambda-rlm-doctor\` first in Pi. It validates setup and, after diagnostics, can offer Formal Leaf Model Selection for entering a manual \`provider/model-id\` value.
3. Manually edit \`[leaf].model\` only as a fallback for non-interactive or diagnostic-only contexts, using a model that already works in Pi:

   \`\`\`toml
   [leaf]
   model = "<provider>/<model-id>"
   \`\`\`

## Files

- \`config.toml\` is a Transparent Sparse Config Scaffold. It is valid before model setup and intentionally leaves \`[leaf].model\` commented so Lambda-RLM never auto-selects a billable model.
- \`examples/\` contains user-editable Copied Example Fixtures copied from the package examples. Missing examples may be restored, but existing files are never overwritten.
- \`prompts/\` is not created automatically. Create sparse prompt overlays there only when you intentionally take ownership of prompt behavior.
`;

function writeIfMissing(path: string, content: string, result: WorkspaceScaffoldingResult) {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
  result.createdFiles.push(path);
}

function copyIfMissing(source: string, target: string, result: WorkspaceScaffoldingResult) {
  if (existsSync(target)) {
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  result.createdFiles.push(target);
}

function copyExampleFixtures(workspacePath: string, result: WorkspaceScaffoldingResult) {
  function visit(directory: string) {
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(sourcePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const targetPath = join(
        workspacePath,
        EXAMPLE_FIXTURE_ROOT,
        relative(PACKAGE_EXAMPLES_DIR, sourcePath),
      );
      copyIfMissing(sourcePath, targetPath, result);
    }
  }

  visit(PACKAGE_EXAMPLES_DIR);
}

export function ensureLambdaRlmUserWorkspace(
  options: WorkspaceScaffoldingOptions = {},
): WorkspaceScaffoldingResult {
  const workspacePath = options.workspacePath ?? defaultLambdaRlmUserWorkspacePath();
  const result: WorkspaceScaffoldingResult = {
    createdDirectories: [],
    createdFiles: [],
    createdWorkspace: !existsSync(workspacePath),
  };

  mkdirSync(workspacePath, { recursive: true });
  if (result.createdWorkspace) {
    result.createdDirectories.push(workspacePath);
  }

  writeIfMissing(join(workspacePath, "config.toml"), TRANSPARENT_SPARSE_CONFIG_SCAFFOLD, result);
  copyExampleFixtures(workspacePath, result);
  writeIfMissing(join(workspacePath, "README.md"), WORKSPACE_README, result);

  return result;
}
