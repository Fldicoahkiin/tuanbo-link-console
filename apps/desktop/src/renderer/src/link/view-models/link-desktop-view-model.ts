import type { LinkDesktopApi, LinkFileBridge } from '@tb/core/link';

/**
 * Renderer 视图模型的桌面能力边界。
 *
 * 组件只依赖此模块与 stores；Electron preload 的全局对象不会扩散进组件层。
 */
export const linkDesktopViewModel: LinkDesktopApi = window.tbLink;
export const linkFileViewModel: LinkFileBridge = window.tbFile;
