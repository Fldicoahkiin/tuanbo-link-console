import type { LinkDesktopBridgeApi, LinkFileBridge } from '@tb/core/link';

declare global {
  interface Window {
    tbLink: LinkDesktopBridgeApi;
    tbFile: LinkFileBridge;
  }
}

export {};
