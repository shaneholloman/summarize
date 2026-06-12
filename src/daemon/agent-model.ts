import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { isOpenRouterBaseUrl } from "@steipete/summarize-core";
import { createRunConfigInput } from "../application/config-state.js";
import { resolveRunContextState } from "../application/context.js";
import { resolveModelSelection } from "../application/model-selection.js";
import type { CliProvider } from "../config.js";
import { buildGitHubModelsHeaders, resolveGitHubModelsApiKey } from "../llm/github-models.js";
import { parseGatewayStyleModelId } from "../llm/model-id.js";
import {
  cliProviderForRequiredEnv,
  getGatewayProviderProfile,
  isGatewayProvider,
  requiredEnvForGatewayProvider,
  type GatewayProvider,
} from "../llm/provider-capabilities.js";
import { resolveMinimaxModel } from "../llm/providers/models.js";
import { createSyntheticModel } from "../llm/providers/shared.js";
import { buildAutoModelAttempts, envHasKey, type AutoModelAttempt } from "../model-auto.js";
import { parseCliUserModelId } from "../run/env.js";
import { resolveRunOverrides } from "../run/run-settings.js";

type AgentApiKeys = {
  openaiApiKey: string | null;
  openrouterApiKey: string | null;
  anthropicApiKey: string | null;
  googleApiKey: string | null;
  xaiApiKey: string | null;
  zaiApiKey: string | null;
  nvidiaApiKey: string | null;
  minimaxApiKey: string | null;
  githubApiKey: string | null;
};

function isCustomOpenAiBaseUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host !== "api.openai.com";
  } catch {
    return false;
  }
}

function overrideModelGatewaySettings({
  provider,
  model,
  baseUrl,
  forceOpenAiChatCompletions,
}: {
  provider: string;
  model: Model<Api>;
  baseUrl: string | null;
  forceOpenAiChatCompletions: boolean | undefined;
}) {
  const nextModel = baseUrl ? ({ ...model, baseUrl } as Model<Api>) : model;
  if (provider !== "openai") return nextModel;
  const effectiveBaseUrl =
    typeof nextModel.baseUrl === "string" && nextModel.baseUrl.trim().length > 0
      ? nextModel.baseUrl.trim()
      : null;
  const isOpenRouterBase = effectiveBaseUrl !== null && isOpenRouterBaseUrl(effectiveBaseUrl);
  const shouldUseChatCompletions = isOpenRouterBase
    ? true
    : typeof forceOpenAiChatCompletions === "boolean"
      ? forceOpenAiChatCompletions
      : isCustomOpenAiBaseUrl(effectiveBaseUrl);
  if (!shouldUseChatCompletions) return nextModel;
  const headers = isOpenRouterBase
    ? {
        ...((nextModel as Model<Api> & { headers?: Record<string, string> }).headers ?? {}),
        "HTTP-Referer": "https://github.com/steipete/summarize",
        "X-Title": "summarize",
      }
    : (nextModel as Model<Api> & { headers?: Record<string, string> }).headers;
  return {
    ...nextModel,
    api: "openai-completions",
    ...(headers ? { headers } : {}),
  } as Model<Api>;
}

function resolveModelWithFallback({
  provider,
  modelId,
  baseUrl,
  forceOpenAiChatCompletions,
}: {
  provider: string;
  modelId: string;
  baseUrl: string | null;
  forceOpenAiChatCompletions: boolean | undefined;
}): Model<Api> {
  try {
    const model = getModel(provider as never, modelId as never);
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    return overrideModelGatewaySettings({
      provider,
      model: model as Model<Api>,
      baseUrl,
      forceOpenAiChatCompletions,
    });
  } catch (error) {
    if (baseUrl) {
      const isOpenRouterBase = isOpenRouterBaseUrl(baseUrl);
      const api =
        provider === "openai" && forceOpenAiChatCompletions === false && !isOpenRouterBase
          ? "openai-responses"
          : "openai-completions";
      return createSyntheticModel({
        provider: provider as never,
        modelId,
        api,
        baseUrl,
        allowImages: false,
      });
    }
    if (provider === "openrouter") {
      return createSyntheticModel({
        provider: "openrouter",
        modelId,
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        allowImages: false,
      });
    }
    throw error;
  }
}

export function resolveApiKeyForModel({
  provider,
  apiKeys,
}: {
  provider: string;
  apiKeys: AgentApiKeys;
}): string {
  if (provider === "openrouter") {
    if (apiKeys.openrouterApiKey) return apiKeys.openrouterApiKey;
    throw new Error("Missing OPENROUTER_API_KEY for openrouter model");
  }
  if (!isGatewayProvider(provider)) {
    throw new Error(`Missing API key for provider: ${provider}`);
  }

  const gatewayApiKeys: Partial<Record<GatewayProvider, string | null>> = {
    openai: apiKeys.openaiApiKey,
    anthropic: apiKeys.anthropicApiKey,
    google: apiKeys.googleApiKey,
    xai: apiKeys.xaiApiKey,
    zai: apiKeys.zaiApiKey,
    nvidia: apiKeys.nvidiaApiKey,
    minimax: apiKeys.minimaxApiKey,
    "github-copilot": apiKeys.githubApiKey,
    ollama: apiKeys.openaiApiKey ?? "ollama",
  };
  const resolved = gatewayApiKeys[provider];
  if (resolved) return resolved;
  throw new Error(`Missing ${requiredEnvForGatewayProvider(provider)} for ${provider} model`);
}

function buildNoAgentModelAvailableError({
  attempts,
  envForAuto,
  cliAvailability,
}: {
  attempts: Pick<AutoModelAttempt, "transport" | "userModelId" | "requiredEnv">[];
  envForAuto: Record<string, string | undefined>;
  cliAvailability: Partial<Record<CliProvider, boolean>>;
}): Error {
  const checked = attempts.map((attempt) => attempt.userModelId);
  const missingEnv = Array.from(
    new Set(
      attempts
        .filter((attempt) => attempt.transport !== "cli")
        .map((attempt) => attempt.requiredEnv)
        .filter((requiredEnv) => !envHasKey(envForAuto, requiredEnv)),
    ),
  );
  const unavailableCli = Array.from(
    new Set(
      attempts
        .filter((attempt) => attempt.transport === "cli")
        .map((attempt) => cliProviderForRequiredEnv(attempt.requiredEnv))
        .filter((provider): provider is CliProvider => provider !== null)
        .filter((provider) => !cliAvailability[provider]),
    ),
  );

  const details = [
    "No model available for agent.",
    checked.length > 0 ? `Checked: ${checked.join(", ")}.` : null,
    missingEnv.length > 0 ? `Missing env: ${missingEnv.join(", ")}.` : null,
    unavailableCli.length > 0 ? `CLI unavailable: ${unavailableCli.join(", ")}.` : null,
    "Restart or reinstall the daemon after changing API keys or CLI installs so its saved environment updates.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  return new Error(details);
}

export async function resolveAgentModel({
  env,
  pageContent,
  modelOverride,
}: {
  env: Record<string, string | undefined>;
  pageContent: string;
  modelOverride: string | null;
}) {
  const {
    config,
    configPath,
    configForCli,
    apiKey,
    openrouterApiKey,
    anthropicApiKey,
    googleApiKey,
    xaiApiKey,
    zaiApiKey,
    providerBaseUrls,
    zaiBaseUrl,
    nvidiaApiKey,
    nvidiaBaseUrl,
    minimaxApiKey,
    minimaxBaseUrl,
    ollamaBaseUrl,
    envForAuto,
    cliAvailability,
    openaiUseChatCompletions,
  } = resolveRunContextState({
    env,
    envForRun: env,
    configInput: createRunConfigInput(),
  });

  const apiKeys: AgentApiKeys = {
    openaiApiKey: apiKey,
    openrouterApiKey,
    anthropicApiKey,
    googleApiKey,
    xaiApiKey,
    zaiApiKey,
    nvidiaApiKey,
    minimaxApiKey,
    githubApiKey: resolveGitHubModelsApiKey(env),
  };

  const overrides = resolveRunOverrides({});
  const maxOutputTokens = overrides.maxOutputTokensArg ?? 2048;

  const { requestedModel, configForModelSelection, isFallbackModel } = resolveModelSelection({
    config,
    configForCli,
    configPath,
    envForRun: env,
    explicitModelArg: modelOverride,
  });

  const providerBaseUrlMap: Partial<Record<GatewayProvider, string | null>> = {
    openai: providerBaseUrls.openai,
    anthropic: providerBaseUrls.anthropic,
    google: providerBaseUrls.google,
    xai: providerBaseUrls.xai,
    zai: zaiBaseUrl,
    nvidia: nvidiaBaseUrl,
    minimax: minimaxBaseUrl,
    "github-copilot": getGatewayProviderProfile("github-copilot").defaultBaseUrl,
    ollama: ollamaBaseUrl,
  };

  const applyBaseUrlOverride = (provider: GatewayProvider | "openrouter", modelId: string) => {
    const profile = provider === "openrouter" ? null : getGatewayProviderProfile(provider);
    const baseUrl =
      provider === "openrouter"
        ? null
        : (providerBaseUrlMap[provider] ?? profile?.defaultBaseUrl ?? null);
    if (provider === "minimax") {
      return {
        provider,
        model: resolveMinimaxModel({
          modelId,
          context: {
            messages: [{ role: "user", content: pageContent, timestamp: Date.now() }],
          },
          openaiBaseUrlOverride: baseUrl,
        }),
      };
    }
    const providerForPiAi =
      provider === "nvidia" || provider === "github-copilot" || provider === "ollama"
        ? "openai"
        : provider;
    const forceOpenAiChatCompletions =
      provider === "openai"
        ? openaiUseChatCompletions
        : provider === "openrouter"
          ? undefined
          : profile?.forceChatCompletions;
    const model = resolveModelWithFallback({
      provider: providerForPiAi,
      modelId,
      baseUrl,
      forceOpenAiChatCompletions,
    });
    return {
      provider,
      model:
        provider === "github-copilot"
          ? { ...model, headers: buildGitHubModelsHeaders(model.headers) }
          : model,
    };
  };

  if (requestedModel.kind === "fixed") {
    if (requestedModel.transport === "cli") {
      return {
        provider: "cli",
        model: null,
        maxOutputTokens,
        apiKeys,
        transport: "cli" as const,
        cliProvider: requestedModel.cliProvider,
        cliModel: requestedModel.cliModel,
        userModelId: requestedModel.userModelId,
        cliConfig: configForCli?.cli ?? null,
      };
    }
    if (requestedModel.transport === "openrouter") {
      const resolved = applyBaseUrlOverride("openrouter", requestedModel.openrouterModelId);
      return { ...resolved, maxOutputTokens, apiKeys };
    }

    const { provider, model } = parseGatewayStyleModelId(requestedModel.llmModelId);
    const resolved = applyBaseUrlOverride(provider, model);
    return { ...resolved, maxOutputTokens, apiKeys };
  }

  if (!isFallbackModel) {
    throw buildNoAgentModelAvailableError({ attempts: [], envForAuto, cliAvailability });
  }

  const estimatedPromptTokens = Math.ceil(pageContent.length / 4);
  const attempts = buildAutoModelAttempts({
    kind: "website",
    promptTokens: estimatedPromptTokens,
    desiredOutputTokens: maxOutputTokens,
    requiresVideoUnderstanding: false,
    env: envForAuto,
    config: configForModelSelection,
    catalog: null,
    openrouterProvidersFromEnv: null,
    cliAvailability,
  });

  let cliAttempt: (typeof attempts)[number] | null = null;
  for (const attempt of attempts) {
    if (attempt.transport === "cli") {
      if (!cliAttempt) cliAttempt = attempt;
      continue;
    }
    if (!envHasKey(envForAuto, attempt.requiredEnv)) continue;
    if (attempt.transport === "openrouter") {
      const modelId = attempt.userModelId.replace(/^openrouter\//i, "");
      const resolved = applyBaseUrlOverride("openrouter", modelId);
      return { ...resolved, maxOutputTokens, apiKeys };
    }
    if (!attempt.llmModelId) continue;
    const { provider, model } = parseGatewayStyleModelId(attempt.llmModelId);
    const resolved = applyBaseUrlOverride(provider, model);
    return { ...resolved, maxOutputTokens, apiKeys };
  }

  if (cliAttempt) {
    const parsed = parseCliUserModelId(cliAttempt.userModelId);
    if (!cliAvailability[parsed.provider]) {
      throw buildNoAgentModelAvailableError({ attempts, envForAuto, cliAvailability });
    }
    return {
      provider: "cli",
      model: null,
      maxOutputTokens,
      apiKeys,
      transport: "cli" as const,
      cliProvider: parsed.provider,
      cliModel: parsed.model,
      userModelId: cliAttempt.userModelId,
      cliConfig: configForCli?.cli ?? null,
    };
  }

  throw buildNoAgentModelAvailableError({ attempts, envForAuto, cliAvailability });
}
