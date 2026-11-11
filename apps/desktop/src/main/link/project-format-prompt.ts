import type { SchemaVersion3Reason } from '@tb/schema';

/** One sentence for each thing that needs the new format, in the order `schemaVersion3Reasons` gives them. */
const reasonSentences: Record<SchemaVersion3Reason, string> = {
  beats: '这个工程的节拍换成了新的存法。',
  blank: '这个工程里有歌在音乐后面留了空白，旧版本存不下。',
  look: '这个工程里有素材的位置和大小要送到 OBS，旧版本存不下。'
};

/**
 * The question before a save turns a project file that 0.5.8 and earlier open into one they cannot (schema 3, 0.5.9
 * E9). Going back to 0.5.8 is the rollback, so this is asked once per such file, and the file is kept beside it first.
 * Every save of the project file passes it (link:save-project); a cancelled question saves nothing.
 * `reasons` says why (`schemaVersion3Reasons`); a project that already is schema 3 for something it no longer holds
 * says so in general words.
 */
export function olderFormatSavePrompt(backupName: string, reasons: readonly SchemaVersion3Reason[]): { type: 'warning'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true } {
  const why = reasons.length ? reasons.map((reason) => reasonSentences[reason]).join('') : '这个工程用到了新版本才有的存法。';
  return {
    type: 'warning', title: '保存工程', noLink: true,
    message: '保存后，0.5.8 和更早的版本打不开这个工程',
    detail: `${why}保存前会先把原来的文件另存一份，放在工程文件旁边：「${backupName}」。要退回旧版本时，打开那一份。`,
    buttons: ['保存', '取消'], defaultId: 0, cancelId: 1
  };
}
