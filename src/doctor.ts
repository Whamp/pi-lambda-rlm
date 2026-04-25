import { fileURLToPath } from "node:url";
import {
  FORMAL_LEAF_READ_ONLY_TOOLS,
  buildFormalPiLeafCommand,
  nodeProcessRunner,
} from "./leaf-runner.js";
import type { Awaitable, ProcessRunner } from "./leaf-runner.js";
import { resolvePromptBundle } from "./prompt-resolver.js";
import { resolveRunConfig } from "./config-resolver.js";
import { runSyntheticBridge } from "./bridge-runner.js";

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

type MockBridgeResult =
  | { ok: true; message: string; details?: Record<string, unknown> }
  | { ok: false; message: string; details?: Record<string, unknown> };

export interface DoctorOptions {
  cwd?: string;
  homeDir?: string;
  pythonPath?: string;
  piExecutable?: string;
  processRunner?: ProcessRunner;
  globalConfigPath?: string;
  projectConfigPath?: string;
  builtInPromptDir?: string;
  globalPromptDir?: string;
  projectPromptDir?: string;
  bridgePath?: string;
  mockBridgeRunner?: () => Awaitable<MockBridgeResult>;
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

async function configCheck(options: DoctorOptions, cwd: string) {
  const configResult = await resolveRunConfig({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
  });
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
    "Fix ~/.pi/lambda-rlm/config.toml or <project>/.pi/lambda-rlm/config.toml; use positive integer [run] keys only.",
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

export async function runLambdaRlmDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const pythonPath = options.pythonPath ?? "python3";
  const piExecutable = options.piExecutable ?? "pi";
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const processRunner = options.processRunner ?? nodeProcessRunner;
  const checks = [
    await pythonVersionCheck(processRunner, pythonPath),
    ...(await lambdaRlmDependencyChecks(processRunner, pythonPath)),
    await configCheck(options, cwd),
    await promptsCheck(options, cwd),
    await piExecutableCheck(processRunner, piExecutable),
    formalLeafCommandCheck(piExecutable),
    await mockBridgeCheck(options, bridgePath, pythonPath),
  ];

  return { checks, ok: checks.every((entry) => entry.status !== "error") };
}
