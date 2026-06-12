import { resolveConfigState, type ConfigState, type RunConfigInput } from "./config-state.js";
import { resolveEnvState, type EnvState } from "./environment-state.js";

export type RunContextState = ConfigState & EnvState;

export function resolveRunContextState({
  env,
  envForRun,
  configInput,
}: {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  configInput: RunConfigInput;
}): RunContextState {
  const configState = resolveConfigState({
    envForRun,
    input: configInput,
  });
  const envState = resolveEnvState({
    env,
    envForRun,
    configForCli: configState.configForCli,
  });
  return { ...configState, ...envState };
}
