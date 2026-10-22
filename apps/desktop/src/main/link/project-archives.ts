import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectArchiveRequestSchema, projectArchiveResultSchema, type ProjectArchiveResult } from '@tb/schema';
import type { ProjectDocumentService } from './project-document-service';

/** Automatic archives kept per project. Only files named ".auto." are counted and trimmed;
 * manual archives and ".before-sync." files from earlier versions are never touched. */
export const AUTOMATIC_ARCHIVE_LIMIT = 50;

/** Snapshots stay beside their project, so every relative media path still resolves. */
export async function projectArchives(input: unknown, documents: Pick<ProjectDocumentService, 'save' | 'inspect'>,
  reveal: (path: string) => void, trash: (path: string) => Promise<void>): Promise<ProjectArchiveResult> {
  const request = projectArchiveRequestSchema.parse(input);
  const projectPath = resolve(request.projectPath);
  if (extname(projectPath).toLowerCase() !== '.tblink' || !(await stat(projectPath)).isFile()) throw new Error('请先保存工程，再使用存档');
  const directory = dirname(projectPath);
  const prefix = `${basename(projectPath, extname(projectPath))}.存档.`;
  let createdPath: string | undefined;
  if (request.action === 'create') {
    await documents.inspect(request.content);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    createdPath = join(directory, `${prefix}${stamp}.${request.reason === 'manual' ? 'manual' : 'auto'}.${randomUUID()}.tblink`);
    await documents.save(createdPath, request.content);
  }
  let entries: ProjectArchiveResult['entries'] = [];
  const automatic = new Set<string>();
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.(manual|before-sync|auto)\.[a-f0-9-]{36}\.tblink$/.exec(name.slice(prefix.length));
    if (!match) continue;
    const stamp = match[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
    const reason = match[2] === 'manual' ? 'manual' : 'before-sync';
    if (match[2] === 'auto') automatic.add(name);
    entries.push({ name, path: join(directory, name), createdAt: stamp, reason });
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (request.action === 'create' && request.reason === 'before-sync') {
    const excess = entries.filter(entry => automatic.has(entry.name)).slice(AUTOMATIC_ARCHIVE_LIMIT);
    for (const entry of excess) await trash(entry.path);
    entries = entries.filter(entry => !excess.includes(entry));
  }
  if (request.action === 'reveal') {
    const entry = request.name ? entries.find(entry => entry.name === request.name) : undefined;
    if (request.name && !entry) throw new Error('该存档不属于当前工程或已移动');
    reveal(entry?.path ?? projectPath);
  }
  return projectArchiveResultSchema.parse({ version: 1, entries, ...(createdPath ? { createdPath } : {}) });
}
