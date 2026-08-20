import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";

interface FlushableResource {
  flush(): Promise<void>;
}

export class PermissionTestResources {
  private readonly tmpDirs: string[] = [];
  private readonly flushables = new Set<FlushableResource>();

  constructor(
    private readonly cleanupDir: (dir: string) => Promise<void> = cleanupTmpDir,
  ) {}

  makeTmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.tmpDirs.push(dir);
    return dir;
  }

  trackFlushable<T extends FlushableResource>(resource: T): T {
    this.flushables.add(resource);
    return resource;
  }

  makeVerdictCache(path: string): VerdictCache {
    return this.trackFlushable(new VerdictCache(path));
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    let flushFailed = false;

    for (const resource of [...this.flushables]) {
      try {
        await resource.flush();
        this.flushables.delete(resource);
      } catch (error) {
        flushFailed = true;
        errors.push(error);
      }
    }

    const cleanedDirs: string[] = [];
    for (const dir of [...this.tmpDirs]) {
      try {
        await this.cleanupDir(dir);
        cleanedDirs.push(dir);
      } catch (error) {
        errors.push(error);
      }
    }

    if (!flushFailed) {
      for (const dir of cleanedDirs) {
        const index = this.tmpDirs.indexOf(dir);
        if (index >= 0) this.tmpDirs.splice(index, 1);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to clean up permission test resources");
    }
  }
}
