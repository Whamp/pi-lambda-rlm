import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { buildFormalPiLeafCommand, nodeProcessRunner, type ProcessRunner } from "./leafRunner.js";
import { resolvePromptBundle } from "./promptResolver.js";
import { resolveRunConfig } from "./configResolver.js";
import { runSyntheticBridge } from "./bridgeRunner.js";

export type DoctorStatus = "ok" | "warn" | "error";

export type DoctorCheck = {
  name: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
  remediation?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

type MockBridgeResult = { ok: true; message: string; details?: Record<string, unknown> } | { ok: false; message: string; details?: Record<string, unknown> };

export type DoctorOptions = {
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
  mockBridgeRunner?: () => Promise<MockBridgeResult>;
};

function check(name: string, status: DoctorStatus, message: string, details?: Record<string, unknown>, remediation?: string): DoctorCheck {
  return { name, status, message, ...(details ? { details } : {}), ...(remediation ? { remediation } : {}) };
}

function defaultBridgePath() {
  return fileURLToPath(new URL("../.pi/extensions/lambda-rlm/bridge.py", import.meta.url));
}

function vendoredRlmPath() {
  return fileURLToPath(new URL("../.pi/extensions/lambda-rlm", import.meta.url));
}

function firstLine(text: string) {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

async function runPythonSeamProbe(processRunner: ProcessRunner, pythonPath: string) {
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
  return processRunner({ command: pythonPath, args: ["-c", script] });
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
  const command = buildFormalPiLeafCommand({ piExecutable, promptFilePath: "/tmp/lambda-rlm-doctor-prompt.txt", leafModel: "doctor-mock" });
  const requiredFlags = ["--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-session"];
  const missingFlags = requiredFlags.filter((flag) => !command.args.includes(flag));
  return { command, requiredFlags, missingFlags, requiredFlagsPresent: missingFlags.length === 0 };
}

async function defaultMockBridgeRunner(options: Required<Pick<DoctorOptions, "bridgePath" | "pythonPath">>) {
  const result = await runSyntheticBridge({
    bridgePath: options.bridgePath,
    pythonPath: options.pythonPath,
    runId: "doctor-mock",
    contextPath: "doctor-inline-context.txt",
    question: "Return the mock answer.",
    context: "The doctor mock path must not require provider credentials.",
    contextWindowChars: 10_000,
    maxModelCalls: 4,
    modelCallRunner: async (call) => ({
      ok: true,
      requestId: call.requestId,
      content: String(call.prompt).includes("Single digit:") ? "2" : "doctor mock answer",
      diagnostics: { stdoutChars: 18, stderr: "", exitCode: 0 },
    }),
  });
  return { ok: true as const, message: "mock bridge completed without model credentials", details: { modelCalls: result.modelCalls } };
}

export async function runLambdaRlmDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const pythonPath = options.pythonPath ?? "python3";
  const piExecutable = options.piExecutable ?? "pi";
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const processRunner = options.processRunner ?? nodeProcessRunner;
  const checks: DoctorCheck[] = [];

  const pythonVersion = await processRunner({ command: pythonPath, args: ["--version"] }).catch((error) => ({ exitCode: null, stdout: "", stderr: String(error) }));
  if (pythonVersion.exitCode === 0) {
    checks.push(check("python", "ok", `Python is available: ${firstLine(pythonVersion.stdout || pythonVersion.stderr) || pythonPath}.`, { pythonPath }));
  } else {
    checks.push(check("python", "error", `Python is not available at ${pythonPath}: ${firstLine(pythonVersion.stderr) || "command failed"}.`, { pythonPath, exitCode: pythonVersion.exitCode }, "Install or configure a working python3 executable; doctor does not install Python automatically."));
  }

  const seamProbe = await runPythonSeamProbe(processRunner, pythonPath).catch((error) => ({ exitCode: null, stdout: "", stderr: String(error) }));
  const probe = parseProbe(seamProbe.stdout);
  if (seamProbe.exitCode !== 0) {
    const reason = probe.error ? String(probe.error) : firstLine(seamProbe.stderr) || "Python probe failed";
    checks.push(check("lambda_rlm_dependency", "error", `Vendored Lambda-RLM dependency is not importable: ${reason}.`, { pythonPath, stderr: seamProbe.stderr }, "Restore the vendored .pi/extensions/lambda-rlm/rlm package or configure Python so the vendored package imports; doctor will not pip install dependencies."));
  } else {
    checks.push(check("lambda_rlm_dependency", "ok", "Vendored Lambda-RLM package imports under the selected Python.", { pythonPath }));
  }

  if (probe.ok === true) {
    checks.push(check("lambda_rlm_fork_seams", "ok", "Local/forked Lambda-RLM exposes required client, prompt registry, and metadata seams.", { seams: probe.seams }));
  } else {
    const missing = Array.isArray(probe.missing) ? probe.missing.map(String) : ["unknown seam"];
    checks.push(check("lambda_rlm_fork_seams", "error", `Local/forked Lambda-RLM is missing required seam(s): ${missing.join(", ")}.`, { missing, stderr: seamProbe.stderr }, "Use the local/forked Lambda-RLM patch that supports injected clients, LambdaPromptRegistry bridge bundles, and explicit model-call metadata."));
  }

  const configResult = await resolveRunConfig({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.globalConfigPath ? { globalConfigPath: options.globalConfigPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
  });
  if (configResult.ok) {
    checks.push(check("config", "ok", "Resolved TOML configuration is valid.", { config: configResult.config }));
  } else {
    checks.push(check("config", "error", configResult.error.message, { code: configResult.error.code, field: configResult.error.field }, "Fix ~/.pi/lambda-rlm/config.toml or <project>/.pi/lambda-rlm/config.toml; use positive integer [run] keys only."));
  }

  const promptResult = await resolvePromptBundle({
    cwd,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.builtInPromptDir ? { builtInPromptDir: options.builtInPromptDir } : {}),
    ...(options.globalPromptDir ? { globalPromptDir: options.globalPromptDir } : {}),
    ...(options.projectPromptDir ? { projectPromptDir: options.projectPromptDir } : {}),
  });
  if (promptResult.ok) {
    checks.push(check("prompts", "ok", "Prompt overlays resolved and placeholder rules validated.", { promptCount: Object.keys(promptResult.bundle.prompts).length }));
  } else {
    checks.push(check("prompts", "error", promptResult.error.message, { code: promptResult.error.code, field: promptResult.error.field }, "Fix the prompt overlay Markdown file or remove the invalid overlay; doctor will not auto-seed or mutate prompt overlays."));
  }

  const piVersion = await processRunner({ command: piExecutable, args: ["--version"] }).catch((error) => ({ exitCode: null, stdout: "", stderr: String(error) }));
  if (piVersion.exitCode === 0) {
    checks.push(check("pi_executable", "ok", `Pi executable is available: ${firstLine(piVersion.stdout || piVersion.stderr) || piExecutable}.`, { piExecutable }));
  } else {
    checks.push(check("pi_executable", "error", `Pi executable is not available at ${piExecutable}: ${firstLine(piVersion.stderr) || "command failed"}.`, { piExecutable, exitCode: piVersion.exitCode }, "Install Pi or configure the pi executable path before real Formal Leaf calls; doctor does not install Pi."));
  }

  const commandShape = verifyFormalLeafCommand(piExecutable);
  checks.push(
    commandShape.requiredFlagsPresent
      ? check("formal_leaf_command", "ok", "Formal Leaf child command includes required no-tools/no-extensions/no-skills/no-context/no-prompt/no-session flags.", commandShape)
      : check("formal_leaf_command", "error", `Formal Leaf child command is missing required flag(s): ${commandShape.missingFlags.join(", ")}.`, commandShape, "Update buildFormalPiLeafCommand so all Formal Leaf Profile disabling flags are present."),
  );

  const mockBridgeRunner = options.mockBridgeRunner ?? (() => defaultMockBridgeRunner({ bridgePath, pythonPath }));
  const mock = await mockBridgeRunner().catch((error) => ({ ok: false as const, message: String(error), details: {} }));
  checks.push(
    mock.ok
      ? check("mock_bridge", "ok", mock.message, mock.details)
      : check("mock_bridge", "error", mock.message, mock.details, "Fix the bridge/tool callback contract. This check uses deterministic fake leaf responses and should not need provider credentials."),
  );

  return { ok: checks.every((entry) => entry.status !== "error"), checks };
}
