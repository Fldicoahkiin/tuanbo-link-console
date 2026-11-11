import { parentPort } from 'node:worker_threads';
import { parseLinkProject } from '@tb/schema';
import { LinkProjectService } from './link-project-service';
import { projectDocumentRequestSchema, projectDocumentResponseSchema, type ProjectDocumentRequest, type ProjectDocumentResponse } from './project-document-contract';

// One service for the lifetime of the app: all manual and automatic document
// saves share its existing per-path write queue and atomic/upgrade-backup rules.
const projects = new LinkProjectService();
async function execute(request: ProjectDocumentRequest): Promise<ProjectDocumentResponse> {
  const envelope = { version: 1 as const, id: request.id };
  switch (request.kind) {
    case 'open': {
      const opened = await projects.openDocument(request.path);
      return { ...envelope, kind: 'opened', content: JSON.stringify(opened.project), upgraded: opened.upgraded };
    }
    case 'inspect': return { ...envelope, kind: 'inspected', name: parseLinkProject(JSON.parse(request.content)).name };
    case 'save': {
      // Validate before admitting to the write queue. An invalid intermediate
      // request must fail even when a later valid revision supersedes it.
      const project = parseLinkProject(JSON.parse(request.content));
      const kept = await projects.save(request.path, project, { backupOriginal: request.backupOriginal, replaceOlderFormat: request.replaceOlderFormat });
      return { ...envelope, kind: 'saved', ...(kept ? { keptOlderFormat: kept } : {}) };
    }
    case 'check-save':
      // Only the version matters here: the save that follows parses and checks the whole content.
      return { ...envelope, kind: 'save-checked', olderFormat: await projects.olderFormatFile(request.path, savedSchemaVersion(request.content)) };
    case 'copy': {
      await projects.writeCopy(request.path, parseLinkProject(JSON.parse(request.content)));
      return { ...envelope, kind: 'saved' };
    }
  }
}
/** The version a project text declares; anything else is left to the full parse of the save. */
function savedSchemaVersion(content: string): number {
  const version = (JSON.parse(content) as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number') throw new Error('工程内容缺少格式版本，没有保存');
  return version;
}
parentPort?.on('message', (value: unknown) => {
  const request = projectDocumentRequestSchema.parse(value);
  void execute(request).then(response => parentPort?.postMessage(projectDocumentResponseSchema.parse(response)), error => {
    parentPort?.postMessage(projectDocumentResponseSchema.parse({ version: 1, id: request.id, kind: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 8192) }));
  });
});
