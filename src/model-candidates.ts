export const MANUAL_MODEL_ENTRY_ID = "__manual_formal_leaf_model__";
export const SHOW_ALL_REGISTERED_MODELS_ID = "__show_all_registered_formal_leaf_models__";

export type CandidateLeafModelSource = "scoped" | "available" | "manual";

export interface RegisteredLeafModel {
  id: string;
  credentialReady: boolean;
  label?: string;
}

export interface CandidateLeafModel {
  id: string;
  label: string;
  credentialReady: boolean;
  source: CandidateLeafModelSource;
  warning?: string;
}

export interface CandidateLeafModelSet {
  defaultCandidates: CandidateLeafModel[];
  expandedCandidates: CandidateLeafModel[];
  noReadyModelsMessage?: string;
  readyModelCount: number;
}

export interface CandidateLeafModelInput {
  registeredModels: RegisteredLeafModel[];
  scopedModelPatterns?: string[];
}

export interface ModelRegistryLike {
  find?: (provider: string, modelId: string) => unknown;
  hasConfiguredAuth?: (model: unknown) => boolean;
  list?: () => unknown[];
  listModels?: () => unknown[];
  getModels?: () => unknown[];
  registeredModels?: unknown[];
  models?: unknown[];
  scopedModels?: unknown[];
  scopedModelPatterns?: string[];
  listScopedModels?: () => unknown[];
  getScopedModels?: () => unknown[];
}

function manualCandidate(): CandidateLeafModel {
  return {
    credentialReady: true,
    id: MANUAL_MODEL_ENTRY_ID,
    label: "Enter a Formal Leaf model manually",
    source: "manual",
  };
}

function uniqModels(models: RegisteredLeafModel[]) {
  const seen = new Set<string>();
  const result: RegisteredLeafModel[] = [];
  for (const model of models) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      result.push(model);
    }
  }
  return result;
}

function asCandidate(
  model: RegisteredLeafModel,
  source: Exclude<CandidateLeafModelSource, "manual">,
): CandidateLeafModel {
  const warning = model.credentialReady
    ? undefined
    : "Missing auth: configure Pi credentials before this Formal Leaf model can pass doctor.";
  return {
    credentialReady: model.credentialReady,
    id: model.id,
    label: `${model.label ?? model.id}${warning ? " (missing auth)" : ""}`,
    source,
    ...(warning ? { warning } : {}),
  };
}

function ready(models: RegisteredLeafModel[]) {
  return models.filter((model) => model.credentialReady);
}

function valueString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
}

function modelId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  const direct = valueString(record, ["id", "name", "model", "modelPattern"]);
  if (direct?.includes("/")) {
    return direct;
  }
  const provider = valueString(record, ["provider", "providerId"]);
  const id = valueString(record, ["modelId", "id", "name"]);
  return provider && id ? `${provider}/${id}` : direct;
}

function splitProviderModel(modelPattern: string) {
  const slash = modelPattern.indexOf("/");
  if (slash <= 0 || slash === modelPattern.length - 1) {
    return;
  }
  return { modelId: modelPattern.slice(slash + 1), provider: modelPattern.slice(0, slash) };
}

function explicitCredentialReady(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["credentialReady", "hasAuth", "authReady", "ready", "available"]) {
      if (typeof record[key] === "boolean") {
        return record[key];
      }
    }
  }
}

function modelCredentialReady(value: unknown, id: string, registry?: ModelRegistryLike) {
  const explicitReady = explicitCredentialReady(value);
  if (typeof explicitReady === "boolean") {
    return explicitReady;
  }
  if (!registry?.hasConfiguredAuth) {
    return false;
  }
  const parsed = splitProviderModel(id);
  const findModel = registry.find?.bind(registry);
  const model = parsed && findModel ? findModel(parsed.provider, parsed.modelId) : value;
  return model ? registry.hasConfiguredAuth(model) : false;
}

function firstArray(...values: unknown[]) {
  return values.find((value): value is unknown[] => Array.isArray(value));
}

export function candidateLeafModelInputFromRegistry(
  registry: ModelRegistryLike | undefined,
): CandidateLeafModelInput {
  if (!registry) {
    return { registeredModels: [] };
  }
  const registered = firstArray(
    registry.registeredModels,
    registry.models,
    registry.list?.(),
    registry.listModels?.(),
    registry.getModels?.(),
  );
  const scoped = firstArray(
    registry.scopedModelPatterns,
    registry.scopedModels,
    registry.listScopedModels?.(),
    registry.getScopedModels?.(),
  );
  return {
    registeredModels: (registered ?? []).flatMap((value) => {
      const id = modelId(value);
      return id
        ? [
            {
              credentialReady: modelCredentialReady(value, id, registry),
              id,
            },
          ]
        : [];
    }),
    scopedModelPatterns: (scoped ?? []).flatMap((value) => {
      const id = modelId(value);
      return id ? [id] : [];
    }),
  };
}

export function resolveCandidateLeafModelSet(
  input: CandidateLeafModelInput,
): CandidateLeafModelSet {
  const registeredModels = uniqModels(input.registeredModels);
  const scopedIds = new Set((input.scopedModelPatterns ?? []).filter((id) => id.trim().length > 0));
  const scopedModels = registeredModels.filter((model) => scopedIds.has(model.id));
  const otherModels = registeredModels.filter((model) => !scopedIds.has(model.id));
  const readyScopedModels = ready(scopedModels);
  const readyOtherModels = ready(otherModels);
  const readyAvailableModels = ready(registeredModels);
  const scopedModelsConfigured = scopedIds.size > 0;
  const defaultReadyModels = scopedModelsConfigured
    ? [...readyScopedModels, ...readyOtherModels]
    : readyAvailableModels;
  const readyModelCount = readyAvailableModels.length;
  const defaultCandidates = [
    ...defaultReadyModels.map((model) =>
      asCandidate(model, scopedIds.has(model.id) ? "scoped" : "available"),
    ),
    manualCandidate(),
  ];
  const expandedCandidates = [
    ...scopedModels.map((model) => asCandidate(model, "scoped")),
    ...otherModels.map((model) => asCandidate(model, "available")),
    manualCandidate(),
  ];

  return {
    defaultCandidates,
    expandedCandidates,
    ...(readyModelCount === 0
      ? {
          noReadyModelsMessage:
            "No credential-ready models are available for Formal Leaf Model Selection. Use /login, configure ~/.pi/agent/models.json for custom/local models, or enter a manual model pattern.",
        }
      : {}),
    readyModelCount,
  };
}
