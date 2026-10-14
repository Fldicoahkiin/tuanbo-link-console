import { setAutomaticMusicAnalysisCommand, setLightingCommand } from '@tb/core/link';
import type { LightingDocument, LinkProject, ReferenceAudio } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
/** Editing only changes the saved document; the running output keeps its snapshot. */
export function lightingEditHandler({ itemId, project, notify }: { itemId: string | null; project: LinkProject | null; notify: (message: string, tone?: 'info' | 'error') => void }) {
  return (document: LightingDocument, label: string, automaticSource?: ReferenceAudio): boolean => {
    if (!itemId) { notify('请先选择要保存灯光素材的节目', 'error'); return false; }
    try {
      if (useDocumentStore.getState().project !== project) throw new Error('工程在操作期间已改变，请重新修改');
      if (automaticSource && !document.musicAnalysis) throw new Error('自动分析没有返回音乐识别结果');
      useDocumentStore.getState().execute(automaticSource && document.musicAnalysis
        ? setAutomaticMusicAnalysisCommand(itemId, automaticSource, document.musicAnalysis)
        : setLightingCommand(itemId, document, label));
      return true;
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); return false; }
  };
}
