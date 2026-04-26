import { describe, expect, it } from "vitest";
import {
  MANUAL_MODEL_ENTRY_ID,
  candidateLeafModelInputFromRegistry,
  resolveCandidateLeafModelSet,
} from "../src/model-candidates.js";

const models = [
  { id: "google/gemini", credentialReady: true },
  { id: "anthropic/claude", credentialReady: true },
  { id: "local/qwen", credentialReady: false },
];

describe("Candidate Leaf Model Set resolver", () => {
  it("lists credential-ready Pi scoped models first when scoped models are configured", () => {
    const set = resolveCandidateLeafModelSet({
      registeredModels: models,
      scopedModelPatterns: ["anthropic/claude"],
    });

    expect(set.defaultCandidates.map((candidate) => candidate.id)).toStrictEqual([
      "anthropic/claude",
      "google/gemini",
      MANUAL_MODEL_ENTRY_ID,
    ]);
    expect(set.defaultCandidates[0]).toMatchObject({
      credentialReady: true,
      source: "scoped",
    });
    expect(set.defaultCandidates[0]).not.toHaveProperty("warning");
  });

  it("falls back to credential-ready available models when no Pi scoped models are configured", () => {
    const set = resolveCandidateLeafModelSet({ registeredModels: models });

    expect(set.defaultCandidates.map((candidate) => candidate.id)).toStrictEqual([
      "google/gemini",
      "anthropic/claude",
      MANUAL_MODEL_ENTRY_ID,
    ]);
  });

  it("keeps other credential-ready available models accessible when scoped models exist", () => {
    const set = resolveCandidateLeafModelSet({
      registeredModels: models,
      scopedModelPatterns: ["anthropic/claude"],
    });

    expect(set.defaultCandidates).toContainEqual(
      expect.objectContaining({ id: "google/gemini", source: "available" }),
    );
  });

  it("expands to all registered models with missing-auth labels and warnings", () => {
    const set = resolveCandidateLeafModelSet({
      registeredModels: models,
      scopedModelPatterns: ["anthropic/claude"],
    });

    expect(set.expandedCandidates.map((candidate) => candidate.id)).toStrictEqual([
      "anthropic/claude",
      "google/gemini",
      "local/qwen",
      MANUAL_MODEL_ENTRY_ID,
    ]);
    expect(set.expandedCandidates).toContainEqual(
      expect.objectContaining({
        credentialReady: false,
        id: "local/qwen",
        label: expect.stringContaining("missing auth"),
        warning: expect.stringContaining("Missing auth"),
      }),
    );
  });

  it("keeps manual model entry as an escape hatch even when no models are credential-ready", () => {
    const set = resolveCandidateLeafModelSet({
      registeredModels: [{ id: "local/qwen", credentialReady: false }],
      scopedModelPatterns: ["local/qwen"],
    });

    expect(set.readyModelCount).toBe(0);
    expect(set.defaultCandidates.map((candidate) => candidate.id)).toStrictEqual([
      MANUAL_MODEL_ENTRY_ID,
    ]);
    expect(set.noReadyModelsMessage).toContain("No credential-ready models");
    expect(set.noReadyModelsMessage).toContain("/login");
  });

  it("resolves string-listed registry models through find before checking configured auth", () => {
    const foundModel = { id: "gpt-4o-mini", provider: "openai" };
    const checkedModels: unknown[] = [];

    const input = candidateLeafModelInputFromRegistry({
      registeredModels: ["openai/gpt-4o-mini"],
      find: (provider, modelId) => {
        expect({ modelId, provider }).toStrictEqual({
          modelId: "gpt-4o-mini",
          provider: "openai",
        });
        return foundModel;
      },
      hasConfiguredAuth: (model) => {
        checkedModels.push(model);
        return model === foundModel;
      },
    });

    expect(checkedModels).toStrictEqual([foundModel]);
    expect(input.registeredModels).toStrictEqual([
      { credentialReady: true, id: "openai/gpt-4o-mini" },
    ]);
  });
});
