import type { LinkDesktopApi, LinkFileBridge } from '@tb/core/link';

declare global {
  interface Window {
    tbLink: LinkDesktopApi;
    tbFile: LinkFileBridge;
  }
}

export {};
