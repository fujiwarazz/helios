import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { WorkspacePaths } from "./paths";

export class LocalDataRootLease {
  private disposed = false;

  private constructor(private readonly releaseLock: () => Promise<void>) {}

  static async acquire(dataRoot: string): Promise<LocalDataRootLease> {
    const paths = new WorkspacePaths(resolve(dataRoot));
    await mkdir(paths.dataRoot, { recursive: true });
    const target = paths.hostLockTarget();
    const handle = await open(target, "a");
    await handle.close();
    try {
      const release = await lockfile.lock(target, {
        realpath: false,
        retries: 0,
        stale: 10_000,
        update: 4_000,
      });
      return new LocalDataRootLease(release);
    } catch (error) {
      throw new Error(
        `HELIOS_DATA_ROOT is already in use; configure a different HELIOS_DATA_ROOT: ${paths.dataRoot}`,
        { cause: error },
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.releaseLock();
  }
}
