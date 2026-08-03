import { InMemoryPoolCoordinatorNamespace } from "./in-memory-coordinator";

export type GcpEnvOptions = {
  variables?: Record<string, string | undefined>;
  db?: Env["DB"];
  actionsLogs?: Env["ACTIONS_LOGS"];
  poolCoordinator?: Env["POOL_COORDINATOR"];
};

export function createGcpEnv(options: GcpEnvOptions): Env {
  if (options.db === undefined) {
    throw new Error("gcp_env_missing_db");
  }
  const env = {
    ...definedVariables(options.variables ?? {}),
    DB: options.db,
    POOL_COORDINATOR:
      options.poolCoordinator ??
      (new InMemoryPoolCoordinatorNamespace() as unknown as Env["POOL_COORDINATOR"]),
    ...(options.actionsLogs === undefined ? {} : { ACTIONS_LOGS: options.actionsLogs }),
  };
  return env as Env;
}

export function createGcpEnvFromProcess(options: Omit<GcpEnvOptions, "variables"> = {}): Env {
  return createGcpEnv({
    ...options,
    variables: process.env,
  });
}

function definedVariables(variables: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
