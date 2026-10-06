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
    case 'open': return { ...envelope, kind: 'opened', content: JSON.stringify(await projects.open(request.path)) };
    case 'inspect': return { ...envelope, kind: 'inspected', name: parseLinkProject(JSON.parse(request.content)).name };
    case 'save': {
      // Validate before admitting to the write queue. An invalid intermediate
      // request must fail even when a later valid revision supersedes it.
      const project = parseLinkProject(JSON.parse(request.content));
      await projects.save(request.path, project);
      return { ...envelope, kind: 'saved' };
    }
  }
}
parentPort?.on('message', (value: unknown) => {
  const request = projectDocumentRequestSchema.parse(value);
  void execute(request).then(response => parentPort?.postMessage(projectDocumentResponseSchema.parse(response)), error => {
    parentPort?.postMessage(projectDocumentResponseSchema.parse({ version: 1, id: request.id, kind: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 8192) }));
  });
});
