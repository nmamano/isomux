import { dirname } from "node:path";

import { setOfficeEnvFileProvider } from "../env-loader.ts";
import { managedOfficeEnvPath, writeManagedOfficeEnv } from "../user-env.ts";
import { assertTestStatePath, removeStateDir } from "./temp-state.ts";

export function setTestManagedOfficeEnv(values: Record<string, string>): void {
  assertTestStatePath(managedOfficeEnvPath());
  setOfficeEnvFileProvider(() => null);
  writeManagedOfficeEnv(values);
}

export function clearTestManagedOfficeEnv(): void {
  removeStateDir(dirname(managedOfficeEnvPath()));
  setOfficeEnvFileProvider(() => null);
}
