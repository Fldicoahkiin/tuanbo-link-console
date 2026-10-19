import { ma2ExecutorPageDirectorySchema, ma2ExecutorPageRequestSchema, ma2LayoutDirectoryRequestSchema, type Ma2ExecutorPageRequest, type Ma2LayoutDirectoryRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2ExecutorPageXml } from './ma2-timecode-xml';

function verifySource(actual: Ma2LayoutDirectoryRequest['expectedSource'] | undefined, expected: Ma2LayoutDirectoryRequest['expectedSource']): void {
  if (!actual || actual.show !== expected.show || actual.version !== expected.version || actual.generation !== expected.generation) throw new Error('控台 Show 或连接会话已变化，请重新读取素材；本页未采用旧数据');
}
export async function readMa2ExecutorPage(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2ExecutorPageRequest) {
  const request = ma2ExecutorPageRequestSchema.parse(input);
  const page = inspectMa2ExecutorPageXml(await bridge.request('PAGE', request.page), request.page);
  verifySource(page.source, request.expectedSource);
  return page;
}
export async function listMa2ExecutorPages(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2LayoutDirectoryRequest) {
  const request = ma2LayoutDirectoryRequestSchema.parse(input);
  const directory = ma2ExecutorPageDirectorySchema.parse(JSON.parse(await bridge.request('PAGES', 1)));
  verifySource(directory, request.expectedSource);
  return directory;
}
