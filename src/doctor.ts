import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORMAL_LEAF_READ_ONLY_TOOLS,
  buildFormalPiLeafCommand,
  nodeProcessRunner,
} from "./leaf-runner.js";
import type { Awaitable, ProcessRunner } from "./leaf-runner.js";
import { resolvePromptBundle } from "./prompt-resolver.js";
import { resolveLambdaRlmConfig, resolveLambdaRlmConfigWithSources } from "./config-resolver.js";
import type { ConfigSource, LambdaRlmConfigSourceReport } from "./config-resolver.js";
import { runSyntheticBridge } from "./bridge-runner.js";
import { ensureLambdaRlmUserWorkspace } from "./workspace-scaffolding.js";

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export type DoctorActionId =
  | "select_formal_leaf_model"
  | "keep_current_configuration"
  | "change_formal_leaf_thinking"
  | "show_config_paths"
  | "cancel_invalid_config_repair"
  | "rewrite_invalid_config_normalized";

export interface DoctorAction {
  id: DoctorActionId;
  label: string;
  description: string;
  recommended: boolean;
  safeDefault: boolean;
}

export interface DoctorActionMenu {
  actions: DoctorAction[];
  defaultActionId: DoctorActionId;
}

type MockBridgeResult =
  | { ok: true; message: string; details?: Record<string, unknown> }
  | { ok: false; message: string; details?: Record<string, unknown> };

interface MinimalModelRegistry {
  find?: (provider: string, modelId: string) => unknown;
  hasConfiguredAuth?: (model: unknown) => boolean;
}

export interface DoctorOptions {
  cwd?: string;
  homeDir?: string;
  pythonPath?: string;
  piExecutable?: string;
  processRunner?: ProcessRunner;
  env?: NodeJS.ProcessEnv;
  modelRegistry?: MinimalModelRegistry;
  globalConfigPath?: string;
  projectConfigPath?: string;
  builtInPromptDir?: string;
  globalPromptDir?: string;
  projectPromptDir?: string;
  bridgePath?: string;
  mockBridgeRunner?: () => Awaitable<MockBridgeResult>;
  workspacePath?: string;
}

function check(
  name: string,
  status: DoctorStatus,
  message: string,
  details?: Record<string, unknown>,
  remediation?: string,
): DoctorCheck {
  return {
    message,
    name,
    status,
    ...(details ? { details } : {}),
    ...(remediation ? { remediation } : {}),
  };
}

function defaultBridgePath() {
  return fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
}

function vendoredRlmPath() {
  return fileURLToPath(new URL("../.pi/extensions/lambda-rlm", import.meta.url));
}

function firstLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function runPythonSeamProbe(processRunner: ProcessRunner, pythonPath: string) {
  const script = String.raw`
import inspect, json, sys
sys.path.insert(0, ${JSON.stringify(vendoredRlmPath())})
missing = []
try:
    from rlm import LambdaRLM, LambdaPromptRegistry
    from rlm.clients import BaseLM
    from rlm.core.types import RLMChatCompletion
    from rlm.core.comms_utils import LMRequest
    from rlm.core.lm_handler import LMHandler
    sig = inspect.signature(LambdaRLM)
    if 'client' not in sig.parameters:
        missing.append('LambdaRLM client parameter')
    if not hasattr(LambdaPromptRegistry, 'from_bridge_bundle'):
        missing.append('LambdaPromptRegistry.from_bridge_bundle')
    if not hasattr(LambdaRLM, '_completion_with_metadata') and 'metadata' not in inspect.signature(LMHandler.completion).parameters:
        missing.append('completion_with_metadata path')
    request_annotations = getattr(LMRequest, '__annotations__', {})
    if 'metadata' not in request_annotations:
        missing.append('LMRequest.metadata')
    annotations = getattr(RLMChatCompletion, '__annotations__', {})
    if 'metadata' not in annotations:
        missing.append('RLMChatCompletion.metadata')
    print(json.dumps({'ok': not missing, 'missing': missing, 'seams': ['LambdaRLM.client', 'LambdaPromptRegistry', 'completion_with_metadata path', 'LMRequest.metadata', 'RLMChatCompletion.metadata']}))
except Exception as exc:
    print(json.dumps({'ok': False, 'error': str(exc), 'missing': ['rlm import']}))
    sys.exit(1)
`;
  return processRunner({ args: ["-c", script], command: pythonPath });
}

function parseProbe(stdout: string): Record<string, unknown> {
  try {
    const line = firstLine(stdout);
    return line ? (JSON.parse(line) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function verifyFormalLeafCommand(piExecutable: string) {
  const command = buildFormalPiLeafCommand({
    leafModel: "doctor-mock",
    piExecutable,
    promptFilePath: "/tmp/lambda-rlm-doctor-prompt.txt",
  });
  const requiredFlags = [
    "--tools",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-session",
  ];
  const missingFlags = requiredFlags.filter((flag) => !command.args.includes(flag));
  const readOnlyToolsPresent = command.args.includes(FORMAL_LEAF_READ_ONLY_TOOLS);
  return {
    command,
    missingFlags,
    readOnlyTools: FORMAL_LEAF_READ_ONLY_TOOLS,
    readOnlyToolsPresent,
    requiredFlags,
    requiredFlagsPresent: missingFlags.length === 0 && readOnlyToolsPresent,
  };
}

async function defaultMockBridgeRunner(
  options: Required<Pick<DoctorOptions, "bridgePath" | "pythonPath">>,
) {
  const result = await runSyntheticBridge({
    bridgePath: options.bridgePath,
    context: "The doctor mock path must not require provider credentials.",
    contextPath: "doctor-inline-context.txt",
    contextWindowChars: 10_000,
    maxModelCalls: 4,
    modelCallRunner: (call) => ({
      content: String(call.prompt).includes("Single digit:") ? "2" : "doctor mock answer",
      diagnostics: { exitCode: 0, stderr: "", stdoutChars: 18 },
      ok: true,
      requestId: call.requestId,
    }),
    pythonPath: options.pythonPath,
    question: "Return the mock answer.",
    runId: "doctor-mock",
  });
  return {
    details: { modelCalls: result.modelCalls },
    message: "mock bridge completed without model credentials",
    ok: true as const,
  };
}

async function pythonVersionCheck(processRunner: ProcessRunner, pythonPath: string) {
  const pythonVersion = await Promise.resolve(
    processRunner({ args: ["--version"], command: pythonPath }),
  ).catch((error) => ({ exitCode: null, stderr: String(error), stdout: "" }));
  if (pythonVersion.exitCode === 0) {
    return check(
      "python",
      "ok",
      `Python is available: ${firstLine(pythonVersion.stdout || pythonVersion.stderr) || pythonPath}.`,
      { pythonPath },
    );
  }
  return check(
    "python",
    "error",
    `Python is not available at ${pythonPath}: ${firstLine(pythonVersion.stderr) || "command failed"}.`,
    { exitCode: pythonVersion.exitCode, pythonPath },
    "Install or configure a working python3 executable; doctor does not install Python automatically.",
  );
}

async function lambdaRlmDependencyChecks(processRunner: ProcessRunner, pythonPath: string) {
  const seamProbe = await Promise.resolve(runPythonSeamProbe(processRunner, pythonPath)).catch(
    (error) => ({
      exitCode: null,
      stderr: String(error),
      stdout: "",
    }),
  );
  const probe = parseProbe(seamProbe.stdout);
  const dependencyCheck =
    seamProbe.exitCode === 0
      ? check(
          "lambda_rlm_dependency",
          "ok",
          "Vendored Lambda-RLM package imports under the selected Python.",
          { pythonPath },
        )
      : check(
          "lambda_rlm_dependency",
          "error",
          `Vendored Lambda-RLM dependency is not importable: ${
            probe.error ? String(probe.error) : firstLine(seamProbe.stderr) || "Python probe failed"
          }.`,
          { pythonPath, stderr: seamProbe.stderr },
          "Restore the vendored .pi/extensions/lambda-rlm/rlm package or configure Python so the vendored package imports; doctor will not pip install dependencies.",
        );

  const missing = Array.isArray(probe.missing) ? probe.missing.map(String) : ["unknown seam"];
  const seamCheck =
    probe.ok === true
      ? check(
          "lambda_rlm_fork_seams",
          "ok",
          "Local/forked Lambda-RLM exposes required client, prompt registry, and metadata seams.",
          { seams: probe.seams },
        )
      : check(
          "lambda_rlm_fork_seams",
          "error",
          `Local/forked Lambda-RLM is missing required seam(s): ${missing.join(", ")}.`,
          { missing, stderr: seamProbe.stderr },
          "Use the local/forked Lambda-RLM patch that supports injected clients, LambdaPromptRegistry bridge bundles, and explicit model-call metadata.",
        );
  return [dependencyCheck, seamCheck];
}

function resolvedConfigForDoctor(options: DoctorOptions, cwd: string) {
  return resolveLambdaRlmConfig({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
  });
}

async function configCheck(options: DoctorOptions, cwd: string) {
  const configResult = await resolvedConfigForDoctor(options, cwd);
  if (configResult.ok) {
    return check("config", "ok", "Resolved TOML configuration is valid.", {
      config: configResult.config,
    });
  }
  return check(
    "config",
    "error",
    configResult.error.message,
    { code: configResult.error.code, field: configResult.error.field },
    "Fix ~/.pi/lambda-rlm/config.toml or <project>/.pi/lambda-rlm/config.toml; use [leaf] string keys and positive integer [run] keys only.",
  );
}

function envLeafModel(options: DoctorOptions) {
  const value = (options.env ?? process.env).LAMBDA_RLM_LEAF_MODEL?.trim();
  return value && value.length > 0 ? value : undefined;
}

function splitProviderModel(modelPattern: string) {
  const slash = modelPattern.indexOf("/");
  if (slash <= 0 || slash === modelPattern.length - 1) {
    return;
  }
  return { modelId: modelPattern.slice(slash + 1), provider: modelPattern.slice(0, slash) };
}

function configSourceLabel(source: string) {
  if (source === "project") {
    return "Project Tool Configuration";
  }
  if (source === "global") {
    return "Global Tool Configuration";
  }
  return "built-in defaults";
}

function effectiveLeafSourceDetails(sources: LambdaRlmConfigSourceReport) {
  const source = sources.leaf.model;
  let effectiveConfigPath: string | undefined;
  if (source === "global") {
    effectiveConfigPath = sources.paths.global;
  } else if (source === "project") {
    effectiveConfigPath = sources.paths.project;
  }
  return {
    ...(effectiveConfigPath ? { effectiveConfigPath } : {}),
    paths: sources.paths,
    source,
    sourceLabel: configSourceLabel(source),
  } satisfies Record<string, unknown> & { source: ConfigSource; sourceLabel: string };
}

function registryModelCheck(
  modelPattern: string,
  modelRegistry: MinimalModelRegistry | undefined,
  sources: LambdaRlmConfigSourceReport,
) {
  const sourceDetails = effectiveLeafSourceDetails(sources);
  const sourceRemediationPrefix = sourceDetails.effectiveConfigPath
    ? `Effective Formal Leaf Model Selection comes from ${sourceDetails.sourceLabel} (${sourceDetails.effectiveConfigPath}). ${sourceDetails.source === "project" ? "Project config overrides global config for this model selection. " : ""}`
    : "";

  if (!modelRegistry?.find || !modelRegistry.hasConfiguredAuth) {
    return;
  }
  const parsed = splitProviderModel(modelPattern);
  if (!parsed) {
    return check(
      "leaf_model",
      "warn",
      `Formal Leaf model is configured as ${modelPattern}, but doctor can only verify exact <provider>/<model-id> patterns against Pi's model registry.`,
      { leafModel: modelPattern, ...sourceDetails },
      `${sourceRemediationPrefix}Prefer an exact provider/model-id accepted by \`pi --model\`, then rerun /lambda-rlm-doctor.`,
    );
  }
  const findModel = modelRegistry.find.bind(modelRegistry);
  const model = findModel(parsed.provider, parsed.modelId);
  if (!model) {
    return check(
      "leaf_model",
      "error",
      `Configured Formal Leaf model ${modelPattern} was not found in Pi's model registry.`,
      {
        leafModel: modelPattern,
        modelId: parsed.modelId,
        provider: parsed.provider,
        ...sourceDetails,
      },
      `${sourceRemediationPrefix}Pick a model shown by \`/model\` or \`pi --list-models\`, or add the provider/model to ~/.pi/agent/models.json.`,
    );
  }
  if (!modelRegistry.hasConfiguredAuth(model)) {
    return check(
      "leaf_model",
      "error",
      `Configured Formal Leaf model ${modelPattern} exists, but Pi does not have credentials for it.`,
      {
        leafModel: modelPattern,
        modelId: parsed.modelId,
        provider: parsed.provider,
        ...sourceDetails,
      },
      `${sourceRemediationPrefix}Run \`/login\`, set the provider API key, or update ~/.pi/agent/auth.json before using lambda_rlm.`,
    );
  }
}

async function leafModelCheck(options: DoctorOptions, cwd: string) {
  const configResult = await resolveLambdaRlmConfigWithSources({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
  });
  if (!configResult.ok) {
    return check(
      "leaf_model",
      "error",
      "Formal Leaf model could not be checked because TOML configuration is invalid.",
      { code: configResult.error.code, field: configResult.error.field },
      "Fix ~/.pi/lambda-rlm/config.toml or <project>/.pi/lambda-rlm/config.toml, then rerun /lambda-rlm-doctor.",
    );
  }
  const configuredModel = configResult.config.config.leaf.model;
  if (configuredModel) {
    const registryCheck = registryModelCheck(
      configuredModel,
      options.modelRegistry,
      configResult.config.sources,
    );
    if (registryCheck) {
      return registryCheck;
    }
    const source = configResult.config.sources.leaf.model;
    const sourceLabel = configSourceLabel(source);
    return check(
      "leaf_model",
      "ok",
      `Formal Leaf model is configured: ${configuredModel}. Effective Formal Leaf Model Selection comes from ${sourceLabel}.`,
      {
        leafModel: configuredModel,
        paths: configResult.config.sources.paths,
        source,
      },
    );
  }

  const envModel = envLeafModel(options);
  if (envModel) {
    return check(
      "leaf_model",
      "error",
      `Formal Leaf model is only set through LAMBDA_RLM_LEAF_MODEL=${envModel}; installed use requires [leaf].model in config.toml.`,
      { leafModel: envModel, source: "env" },
      'Add [leaf] model = "<provider>/<model-id>" to ~/.pi/lambda-rlm/config.toml for stable global setup.',
    );
  }

  return check(
    "leaf_model",
    "error",
    "No Formal Leaf model is configured. Missing required [leaf].model for real Lambda-RLM runs.",
    { source: "missing" },
    'Create ~/.pi/lambda-rlm/config.toml with [leaf]\nmodel = "<provider>/<model-id>" using a model accepted by `pi --model`.',
  );
}

async function promptsCheck(options: DoctorOptions, cwd: string) {
  const promptResult = await resolvePromptBundle({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.builtInPromptDir ? { builtInPromptDir: options.builtInPromptDir } : {}),
    ...(options.globalPromptDir ? { globalPromptDir: options.globalPromptDir } : {}),
    ...(options.projectPromptDir ? { projectPromptDir: options.projectPromptDir } : {}),
  });
  if (promptResult.ok) {
    return check("prompts", "ok", "Prompt overlays resolved and placeholder rules validated.", {
      promptCount: Object.keys(promptResult.bundle.prompts).length,
    });
  }
  return check(
    "prompts",
    "error",
    promptResult.error.message,
    { code: promptResult.error.code, field: promptResult.error.field },
    "Fix the prompt overlay Markdown file or remove the invalid overlay; doctor will not auto-seed or mutate prompt overlays.",
  );
}

async function piExecutableForDoctor(options: DoctorOptions, cwd: string) {
  if (options.piExecutable) {
    return options.piExecutable;
  }
  const configResult = await resolvedConfigForDoctor(options, cwd);
  return configResult.ok ? configResult.config.leaf.piExecutable : "pi";
}

async function piExecutableCheck(processRunner: ProcessRunner, piExecutable: string) {
  const piVersion = await Promise.resolve(
    processRunner({ args: ["--version"], command: piExecutable }),
  ).catch((error) => ({ exitCode: null, stderr: String(error), stdout: "" }));
  if (piVersion.exitCode === 0) {
    return check(
      "pi_executable",
      "ok",
      `Pi executable is available: ${firstLine(piVersion.stdout || piVersion.stderr) || piExecutable}.`,
      { piExecutable },
    );
  }
  return check(
    "pi_executable",
    "error",
    `Pi executable is not available at ${piExecutable}: ${firstLine(piVersion.stderr) || "command failed"}.`,
    { exitCode: piVersion.exitCode, piExecutable },
    "Install Pi or configure the pi executable path before real Formal Leaf calls; doctor does not install Pi.",
  );
}

function formalLeafCommandCheck(piExecutable: string) {
  const commandShape = verifyFormalLeafCommand(piExecutable);
  if (commandShape.requiredFlagsPresent) {
    return check(
      "formal_leaf_command",
      "ok",
      "Formal Leaf child command includes Pi's read-only tools plus no-extensions/no-skills/no-context/no-prompt/no-session flags.",
      commandShape,
    );
  }
  return check(
    "formal_leaf_command",
    "error",
    `Formal Leaf child command is missing required read-only tool configuration or flag(s): ${commandShape.missingFlags.join(", ")}.`,
    commandShape,
    "Update buildFormalPiLeafCommand so all Formal Leaf Profile disabling flags are present.",
  );
}

async function mockBridgeCheck(
  options: Pick<DoctorOptions, "mockBridgeRunner">,
  bridgePath: string,
  pythonPath: string,
) {
  const mockBridgeRunner =
    options.mockBridgeRunner ?? (() => defaultMockBridgeRunner({ bridgePath, pythonPath }));
  const mock = await Promise.resolve(mockBridgeRunner()).catch((error) => ({
    details: {},
    message: String(error),
    ok: false as const,
  }));
  if (mock.ok) {
    return check("mock_bridge", "ok", mock.message, mock.details);
  }
  return check(
    "mock_bridge",
    "error",
    mock.message,
    mock.details,
    "Fix the bridge/tool callback contract. This check uses deterministic fake leaf responses and should not need provider credentials.",
  );
}

function doctorScaffoldWorkspacePath(options: DoctorOptions) {
  if (options.workspacePath) {
    return options.workspacePath;
  }
  if (options.globalConfigPath) {
    return dirname(options.globalConfigPath);
  }
  if (options.homeDir) {
    return join(options.homeDir, ".pi", "lambda-rlm");
  }
}

function hasLeafModelProblem(report: DoctorReport) {
  return report.checks.some((entry) => entry.name === "leaf_model" && entry.status !== "ok");
}

function hasInvalidConfigProblem(report: DoctorReport) {
  return report.checks.some((entry) => entry.name === "config" && entry.status === "error");
}

export function buildDoctorActionMenu(report: DoctorReport): DoctorActionMenu {
  const invalidConfigProblem = hasInvalidConfigProblem(report);
  const recommendModelSelection = hasLeafModelProblem(report) && !invalidConfigProblem;
  const recommendKeepCurrent = report.ok && !recommendModelSelection;
  const actions: DoctorAction[] = [
    ...(invalidConfigProblem
      ? [
          {
            description:
              "Cancel invalid config repair and leave the Tool Configuration File untouched.",
            id: "cancel_invalid_config_repair" as const,
            label: "Cancel invalid config repair",
            recommended: true,
            safeDefault: true,
          },
          {
            description:
              "After explicit confirmation, create or preserve a backup and replace invalid config with a normalized Transparent Sparse Config Scaffold.",
            id: "rewrite_invalid_config_normalized" as const,
            label: "Confirmed normalized rewrite of invalid config",
            recommended: false,
            safeDefault: false,
          },
        ]
      : []),
    {
      description:
        "Start Formal Leaf Model Selection. This Doctor Repair Flow is available after every diagnostic run, including passing runs.",
      id: "select_formal_leaf_model",
      label: "Choose or change the Formal Leaf model",
      recommended: recommendModelSelection,
      safeDefault: false,
    },
    {
      description: "Keep the current Lambda-RLM configuration without mutating files.",
      id: "keep_current_configuration",
      label: "Keep current configuration",
      recommended: recommendKeepCurrent,
      safeDefault: recommendKeepCurrent,
    },
    {
      description:
        "Open Formal Leaf Thinking Selection later; this is tuning and is not required for readiness.",
      id: "change_formal_leaf_thinking",
      label: "Change Formal Leaf thinking level",
      recommended: false,
      safeDefault: false,
    },
    {
      description: "Show global/project configuration paths and source precedence.",
      id: "show_config_paths",
      label: "Show config paths and precedence",
      recommended: false,
      safeDefault: false,
    },
  ];
  let defaultActionId: DoctorActionId = "keep_current_configuration";
  if (invalidConfigProblem) {
    defaultActionId = "cancel_invalid_config_repair";
  } else if (recommendModelSelection) {
    defaultActionId = "select_formal_leaf_model";
  }
  return { actions, defaultActionId };
}

function diagnosticLine(checkEntry: DoctorCheck) {
  const details = checkEntry.details ?? {};
  const field = typeof details.field === "string" ? details.field : undefined;
  const code = typeof details.code === "string" ? details.code : undefined;
  const detailSuffix = [code ? `code=${code}` : undefined, field ? `field=${field}` : undefined]
    .filter(Boolean)
    .join(", ");
  return `- [${checkEntry.status}] ${checkEntry.name}: ${checkEntry.message}${detailSuffix ? ` (${detailSuffix})` : ""}`;
}

function manualRemediationSnippets(report: DoctorReport) {
  const snippets: string[] = [];
  const leafModel = report.checks.find((entry) => entry.name === "leaf_model");
  if (leafModel?.status !== "ok") {
    const details = leafModel?.details ?? {};
    const effectiveConfigPath =
      typeof details.effectiveConfigPath === "string" ? details.effectiveConfigPath : undefined;
    const source = typeof details.source === "string" ? details.source : undefined;
    const editTarget = effectiveConfigPath ?? "~/.pi/lambda-rlm/config.toml";
    const ownershipNote = effectiveConfigPath
      ? `Effective Formal Leaf Model Selection comes from ${configSourceLabel(source ?? "default")} at ${effectiveConfigPath}.${source === "project" ? " Project config overrides global config for this model selection." : ""}`
      : "No effective config source path was available; if a project config sets [leaf].model, it overrides global config for this project.";
    snippets.push(`Missing or invalid Formal Leaf model:

${ownershipNote}

Edit ${editTarget}:

\`\`\`toml
[leaf]
model = "<provider>/<model-id>"
\`\`\`

Choose a model that Pi already accepts, for example one shown by:

\`\`\`bash
pi --list-models
\`\`\`

Then rerun /lambda-rlm-doctor.`);
  }
  const invalidConfig = report.checks.find(
    (entry) => entry.name === "config" && entry.status === "error",
  );
  if (invalidConfig) {
    snippets.push(`Invalid Lambda-RLM setup/configuration:

Fix TOML syntax and supported keys in ~/.pi/lambda-rlm/config.toml or <project>/.pi/lambda-rlm/config.toml. Minimal valid setup:

\`\`\`toml
[leaf]
model = "<provider>/<model-id>"
thinking = "off"
pi_executable = "pi"
\`\`\`

Doctor will not normalize, rewrite, or mutate invalid configuration in Diagnostic-Only Doctor Mode.`);
  }
  for (const entry of report.checks) {
    if (
      entry.status !== "ok" &&
      entry.remediation &&
      entry.name !== "leaf_model" &&
      entry.name !== "config"
    ) {
      snippets.push(`${entry.name}: ${entry.remediation}`);
    }
  }
  return snippets;
}

export function renderDoctorCommandOutput(
  report: DoctorReport,
  options: { interactive: boolean },
): string {
  const lines = [
    `lambda_rlm doctor ${report.ok ? "passed" : "found errors"}: ${report.checks.filter((entry) => entry.status === "error").length} error(s), ${report.checks.filter((entry) => entry.status === "warn").length} warning(s).`,
    "",
    "Diagnostics:",
    ...report.checks.map(diagnosticLine),
  ];
  if (options.interactive) {
    const menu = buildDoctorActionMenu(report);
    lines.push("", "Post-diagnostics action menu (Doctor Repair Flow):");
    for (const action of menu.actions) {
      const badges = [
        action.recommended ? "recommended" : undefined,
        action.safeDefault ? "safe default" : undefined,
      ].filter(Boolean);
      lines.push(
        `- ${action.id}${badges.length > 0 ? ` (${badges.join(", ")})` : ""}: ${action.label}`,
      );
    }
    lines.push(`Default action: ${menu.defaultActionId}`);
  } else {
    const snippets = manualRemediationSnippets(report);
    lines.push(
      "",
      "Diagnostic-Only Doctor Mode: no UI prompts were shown and no Doctor Repair Flow mutations were performed.",
    );
    if (snippets.length > 0) {
      lines.push("", "Manual remediation snippets:", snippets.join("\n\n---\n\n"));
    }
  }
  return lines.join("\n");
}

export async function runLambdaRlmDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const scaffoldWorkspacePath = doctorScaffoldWorkspacePath(options);
  if (process.env.NODE_ENV !== "test" || scaffoldWorkspacePath) {
    await ensureLambdaRlmUserWorkspace(
      scaffoldWorkspacePath ? { workspacePath: scaffoldWorkspacePath } : {},
    );
  }
  const cwd = options.cwd ?? process.cwd();
  const pythonPath = options.pythonPath ?? "python3";
  const piExecutable = await piExecutableForDoctor(options, cwd);
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const processRunner = options.processRunner ?? nodeProcessRunner;
  const checks = [
    await pythonVersionCheck(processRunner, pythonPath),
    ...(await lambdaRlmDependencyChecks(processRunner, pythonPath)),
    await configCheck(options, cwd),
    await leafModelCheck(options, cwd),
    await promptsCheck(options, cwd),
    await piExecutableCheck(processRunner, piExecutable),
    formalLeafCommandCheck(piExecutable),
    await mockBridgeCheck(options, bridgePath, pythonPath),
  ];

  return { checks, ok: checks.every((entry) => entry.status !== "error") };
}
