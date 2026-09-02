import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { setOfficeEnvFileProvider } from "../env-loader.ts";
import { managedOfficeEnvPath, writeManagedOfficeEnv } from "../user-env.ts";

export function setTestManagedOfficeEnv(values: Record<string, string>): void {
  setOfficeEnvFileProvider(() => null);
  writeManagedOfficeEnv(values);
}

export function clearTestManagedOfficeEnv(): void {
  setOfficeEnvFileProvider(() => null);
  rmSync(dirname(managedOfficeEnvPath()), { recursive: true, force: true });
}
