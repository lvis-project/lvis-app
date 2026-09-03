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

  /**
   * A factory for paths to `fileName`, each inside its own fresh scratch
   * directory this instance owns.
   *
   * Four suites wrapped `makeTmpDir` + `join` in a local function so their call
   * sites could stay bare, and the wrapper is the duplicated part. The prefix
   * and the file name are not: the name is the production filename the suite is
   * about, and it belongs at the one place the suite names its subject.
   *
   * A method rather than a free function with its own `afterAll`, because the
   * directory has to stay this instance's: `verdict-cache` calls `cleanup()`
   * mid-test and asserts the directory is gone, and `permission-slash` makes
   * further directories through the same instance.
   */
  tmpFilePaths(prefix: string, fileName: string): () => string {
    return () => join(this.makeTmpDir(prefix), fileName);
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
