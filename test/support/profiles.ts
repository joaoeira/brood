import type { Model } from "@earendil-works/pi-ai";
import type { ExactModelLookup, ModelProfile, ProfilesConfigInput } from "../../src/agent.js";

export const scriptedModel: Model<"openai-responses"> = {
  id: "scripted-small",
  name: "Scripted Small",
  api: "openai-responses",
  provider: "scripted",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 2_048,
};

export const testProfile = (overrides?: Partial<ModelProfile>): ModelProfile => ({
  description: "test worker",
  provider: "scripted",
  model: "scripted-small",
  thinkingLevel: "off",
  ...overrides,
});

export const testProfilesConfig = (
  overrides?: Partial<ProfilesConfigInput>,
): ProfilesConfigInput => ({
  defaultProfile: "worker",
  profiles: { worker: testProfile() },
  ...overrides,
});

export const testModelLookup = (): ExactModelLookup => ({
  getModel: (provider, model) =>
    provider === scriptedModel.provider && model === scriptedModel.id ? scriptedModel : undefined,
});
