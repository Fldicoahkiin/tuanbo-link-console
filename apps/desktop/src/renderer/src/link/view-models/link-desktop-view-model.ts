import type { LinkDesktopApi, LinkFileBridge } from '@tb/core/link';
import { projectDocumentEnvelopeSchema } from '@tb/schema';
import { projectCodec } from '../stores/project-codec';
import { allowProjectReopen } from '../stores/project-recovery';

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
    return { path: document.path, project, upgraded: document.upgraded };
  },
  openProject: async path => {
    const document = projectDocumentEnvelopeSchema.parse(await window.tbLink.openProjectDocument(path));
    return { path: document.path, project: await projectCodec.decode(document.content), upgraded: document.upgraded };
  },
  resolveRecoveryCopy: async query => {
    const copy = await window.tbLink.resolveRecoveryCopyDocument(query);
    return copy ? projectCodec.decode(copy.content) : null;
  }
};
export const linkFileViewModel: LinkFileBridge = window.tbFile;
