import { parseLinkProject } from '@tb/schema';
import { projectCodecRequestSchema, type ProjectCodecResponse } from './project-codec-protocol';

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = projectCodecRequestSchema.parse(event.data);
  let response: ProjectCodecResponse;
  try {
    response = request.kind === 'decode'
      ? { version: 1, id: request.id, kind: 'decoded', project: parseLinkProject(JSON.parse(request.content)) }
      : { version: 1, id: request.id, kind: 'encoded', content: JSON.stringify(parseLinkProject(request.project)) };
  } catch (error) { response = { version: 1, id: request.id, kind: 'error', message: error instanceof Error ? error.message : String(error) }; }
  self.postMessage(response);
});
