import { ma2ExecutorPageSchema, ma2ExecutorPageDirectorySchema, ma2ExecutorPageRequestSchema, ma2LayoutDirectoryRequestSchema, type Ma2ExecutorPageRequest, type Ma2LayoutDirectoryRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2ExecutorPageXml } from './ma2-timecode-xml';

function verifySource(actual: Ma2LayoutDirectoryRequest['expectedSource'] | undefined, expected: Ma2LayoutDirectoryRequest['expectedSource']): void {
  if (!actual || actual.show !== expected.show || actual.version !== expected.version || actual.generation !== expected.generation) throw new Error('控台的 Show 或连接变了，请重新读取素材；这一页没有使用旧数据');
}
export async function readMa2ExecutorPage(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2ExecutorPageRequest) {
  const request = ma2ExecutorPageRequestSchema.parse(input);
  let xml: string;
  try { xml = await bridge.request('PAGE', request.page); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith('Executor Page does not exist')) throw error;
    // A missing page is a valid navigation target. Confirm absence and source with a fresh directory;
    // never turn a connection failure, changed Show, or a page that reappeared into an empty page.
    const directory = await listMa2ExecutorPages(bridge, { network: request.network, expectedSource: request.expectedSource });
    if (directory.pages.some(value => value.page === request.page)) throw new Error(`控台第 ${request.page} 页在读取期间发生变化，请刷新这一页`);
    return ma2ExecutorPageSchema.parse({ page: request.page, name: '', exists: false, readAt: new Date().toISOString(),
      source: { show: directory.show, version: directory.version, generation: directory.generation }, items: [] });
  }
  const page = inspectMa2ExecutorPageXml(xml, request.page);
  verifySource(page.source, request.expectedSource);
  return page;
}
export async function listMa2ExecutorPages(bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2LayoutDirectoryRequest) {
  const request = ma2LayoutDirectoryRequestSchema.parse(input);
  const directory = ma2ExecutorPageDirectorySchema.parse(JSON.parse(await bridge.request('PAGES', 1)));
  verifySource(directory, request.expectedSource);
  return directory;
}
