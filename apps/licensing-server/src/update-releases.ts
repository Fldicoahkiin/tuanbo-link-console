import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { updateStatusSchema, type UpdateOutcome, type UpdateRequest, type UpdateStatus } from './console-contract';
import { ServiceError } from './service';

const outcomeSchema = z.object({ id: z.string(), ok: z.boolean(), message: z.string(), at: z.string() });

/** The console's side of the update spool. It never touches the feed: a root path unit runs
 * publish-update.py for each request, re-validates the release and writes the outcome back. */
export class UpdateReleases {
  constructor(private readonly directory: string, private readonly waitMs = 60_000, private readonly pollMs = 500) {}

  async status(): Promise<UpdateStatus> {
    try {
      return updateStatusSchema.parse(JSON.parse(await readFile(join(this.directory, 'update-status.json'), 'utf8')));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new ServiceError(503, 'UPDATES_UNAVAILABLE', '发布助手尚未生成状态，请确认服务器已安装 tblink-update-publish.path');
      throw error;
    }
  }

  /** Resolves with the outcome, or null when the publisher has not answered within the wait. The request
   * directory is this account's: the root publisher only reads it, so answered requests are removed here. */
  async request(request: UpdateRequest): Promise<UpdateOutcome | null> {
    await this.removeAnswered();
    const pending = join(this.directory, 'update-requests', `.${request.id}.tmp`);
    // Written under a name the path unit ignores, then renamed: the publisher never sees half a request.
    await writeFile(pending, JSON.stringify(request), { flag: 'wx', mode: 0o640 });
    await rename(pending, join(this.directory, 'update-requests', `${request.id}.json`));
    const result = join(this.directory, 'update-results', `${request.id}.json`);
    for (let waited = 0; waited < this.waitMs; waited += this.pollMs) {
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
      try {
        const outcome = outcomeSchema.parse(JSON.parse(await readFile(result, 'utf8')));
        await unlink(join(this.directory, 'update-requests', `${request.id}.json`));
        return { ok: outcome.ok, message: outcome.message };
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return null;
  }

  private async removeAnswered(): Promise<void> {
    const answered = new Set(await readdir(join(this.directory, 'update-results')));
    for (const name of await readdir(join(this.directory, 'update-requests'))) {
      if (answered.has(name)) await unlink(join(this.directory, 'update-requests', name));
    }
  }
}
