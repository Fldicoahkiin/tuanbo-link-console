import { ma2TimecodePreviewSchema, ma2ReadStateSchema, parseLinkProject, type Ma2TimecodePreview, type Ma2ReadState } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { importMa2TimecodeCommand } from './ma2-import';

export function saveMa2ReadStateCommand(input: Ma2ReadState): LinkCommand {
  const state = ma2ReadStateSchema.parse(input);
  return { id: crypto.randomUUID(), label: '保存控台读取与配对状态', execute: project => parseLinkProject({ ...project, schemaVersion: 2, ma2ReadState: state, updatedAt: new Date().toISOString() }), undo: before => parseLinkProject(before) };
}

/** One history entry; a failed pairing never leaves a partially imported project. */
export function importMa2ProgramsCommand(selections: readonly { itemId: string; preview: Ma2TimecodePreview }[]): LinkCommand {
  if (!selections.length) throw new Error('请先选择歌曲与灯光时间线的对应关系');
  const targets = new Set<number>();
  const commands = selections.map(({ itemId, preview: value }) => {
    const preview = ma2TimecodePreviewSchema.parse(value);
    if (targets.has(preview.target)) throw new Error('同一 Timecode 不能在本次导入中重复配对');
    targets.add(preview.target);
    return { itemId, command: importMa2TimecodeCommand(itemId, preview) };
  });
  return { id: crypto.randomUUID(), label: '导入已配对的 MA2 灯光节目', execute(project) {
    let next = project;
    for (const { itemId, command } of commands) {
      const item = project.rundown.find(entry => entry.id === itemId);
      if (!item) throw new Error('接收灯光的歌曲已不存在');
      next = command.execute(next);
    }
    return parseLinkProject(next);
  }, undo: before => parseLinkProject(before) };
}
