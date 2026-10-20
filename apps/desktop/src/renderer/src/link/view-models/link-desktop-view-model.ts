import type { LinkDesktopApi, LinkFileBridge } from '@tb/core/link';
import { projectDocumentEnvelopeSchema } from '@tb/schema';
import { projectCodec } from '../stores/project-codec';
import { allowProjectReopen } from '../stores/project-recovery';

let saveTail: Promise<unknown> = Promise.resolve();
const saveProject: LinkDesktopApi['saveProject'] = (path, project) => {
  // Preserve caller order across encoding, IPC and the atomic disk write.
  const result = saveTail.then(async () => window.tbLink.saveProjectDocument(path, await projectCodec.encode(project)));
  saveTail = result.then(() => undefined, () => undefined);
  return result;
};
/**
 * Renderer 视图模型的桌面能力边界。
 *
 * 组件只依赖此模块与 stores；Electron preload 的全局对象不会扩散进组件层。
 */
export const linkDesktopViewModel: LinkDesktopApi = {
  ...window.tbLink,
  pickOpenProject: async () => {
    const result = await window.tbLink.pickProjectDocument();
    if (result === null) return null;
    const document = projectDocumentEnvelopeSchema.parse(result);
    const project = await projectCodec.decode(document.content);
    allowProjectReopen(document.path);
    return { path: document.path, project };
  },
  openProject: async path => {
    const document = projectDocumentEnvelopeSchema.parse(await window.tbLink.openProjectDocument(path));
    return { path: document.path, project: await projectCodec.decode(document.content) };
  },
  saveProject
};
export const linkFileViewModel: LinkFileBridge = window.tbFile;
