import { toUserErrorMessage } from '@tb/core/link';
import { ObsPreviewSession } from '../../registry/obs-preview-session';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { linkDesktopViewModel as desktop } from './link-desktop-view-model';

export const obsPreviewSession = new ObsPreviewSession({
  getObsLiveFrame: async () => {
    try {
      const frame = await desktop.getObsLiveFrame();
      if (frame.width <= 0 || frame.height <= 0 || frame.rgba.byteLength !== frame.width * frame.height * 4) throw new Error('OBS 预览画面数据不完整');
      const checks = useConnectionCheckStore.getState();
      if (checks.checks.preview?.state !== 'ready') checks.finish('preview', 'ready', '已收到 OBS 预览画面');
      return frame;
    } catch (error) {
      useConnectionCheckStore.getState().finish('preview', 'error', toUserErrorMessage(error));
      throw error;
    }
  },
  closeObsLivePreview: () => desktop.closeObsLivePreview()
});
