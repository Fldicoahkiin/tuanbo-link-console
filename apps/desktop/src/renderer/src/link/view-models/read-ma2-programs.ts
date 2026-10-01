import { importMa2ProgramsCommand } from '@tb/core/link';
import { ma2TimecodePreviewSchema, type LinkProject, type Ma2TimecodePreview } from '@tb/schema';

export type Ma2ImportFailure = { target: number; message: string };
export async function readMa2Programs(project: LinkProject, pairs: readonly [string, string][], read: (target: number) => Promise<unknown>, assertCurrent: () => void, progress: (completed: number, detail: string) => void) {
  const selections: { itemId: string; preview: Ma2TimecodePreview }[] = [];
  const failures: Ma2ImportFailure[] = [];
  let validated = project;
  for (const [number, itemId] of pairs) {
    assertCurrent();
    const target = Number(number);
    progress(selections.length + failures.length, `正在读取 Timecode ${target} → ${project.rundown.find(item => item.id === itemId)?.title ?? '歌曲'}`);
    try {
      const preview = ma2TimecodePreviewSchema.parse(await read(target));
      if (preview.target !== target) throw new Error('控台返回的时间线编号不一致');
      const selection = { itemId, preview };
      validated = importMa2ProgramsCommand([selection]).execute(validated);
      selections.push(selection);
    } catch (error) { failures.push({ target, message: error instanceof Error ? error.message : String(error) }); }
    assertCurrent();
    progress(selections.length + failures.length, `已检查 Timecode ${target} · ${selections.length} 条可导入 · ${failures.length} 条失败`);
  }
  return { selections, failures };
}
