import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";

interface FlushableResource {
  flush(): Promise<void>;
}

export class PermissionTestResources {
  private readonly tmpDirs: string[] = [];
  private readonly flushables = new Set<FlushableResource>();

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
    for (const resource of this.flushables) {
      await resource.flush();
    }
    this.flushables.clear();

    for (const dir of this.tmpDirs.splice(0)) {
      await cleanupTmpDir(dir);
    }
  }
}
