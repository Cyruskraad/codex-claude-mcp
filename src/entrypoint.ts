import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Compares physical files so macOS `/var` and `/private/var` aliases behave identically. */
export function isCanonicalEntrypoint(moduleUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) return false;
  try {
    const modulePath = realpathSync.native(fileURLToPath(moduleUrl));
    const executablePath = realpathSync.native(resolve(invokedPath));
    return modulePath === executablePath;
  } catch {
    return false;
  }
}
