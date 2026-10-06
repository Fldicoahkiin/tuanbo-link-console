import { it, expect } from 'vitest';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseLinkProject } from '@tb/schema';
import { replaceCueCommand } from '@tb/core/link';
import { useDocumentStore } from './document-store';

it.skipIf(!process.env.TBLINK_STABILITY_FIXTURE)('200 节目高负载编辑历史保持结构共享与完整撤销', async () => {
  const file = resolve(process.env.TBLINK_STABILITY_FIXTURE!);
  const project = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
  expect(project.rundown).toHaveLength(200); expect(project.mediaAssets).toHaveLength(2000);
  const store = useDocumentStore.getState(); store.setProject(project, file);
  const original = useDocumentStore.getState().project!;
  const samples: number[] = [];
  const memory = [{ operation: 0, ...process.memoryUsage() }];
  try {
    for (let index = 0; index < 100; index++) {
      const item = useDocumentStore.getState().project!.rundown[0]!;
      const cue = item.cues[index % item.cues.length]!;
      const started = performance.now();
      store.execute(replaceCueCommand(item.id, { ...cue, name: `压力修改 ${index}` }));
      samples.push(performance.now() - started);
      const changed = useDocumentStore.getState().project!;
      expect(changed.rundown[199]).toBe(original.rundown[199]);
      expect(changed.mediaAssets).toBe(original.mediaAssets);
      expect(changed.rundown[0]!.lighting).toBe(original.rundown[0]!.lighting);
      if (index % 10 === 9) memory.push({ operation: index + 1, ...process.memoryUsage() });
    }
    expect(useDocumentStore.getState().past).toHaveLength(100);
    for (let index = 0; index < 100; index++) store.undo();
    expect(useDocumentStore.getState().project).toBe(original);
    for (let index = 0; index < 100; index++) store.redo();
    expect(useDocumentStore.getState().project!.rundown[0]!.cues[99]!.name).toBe('压力修改 99');
  } finally {
    const directory = resolve('artifacts', `document-load-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await mkdir(directory, { recursive: true });
    const sorted = [...samples].sort((a, b) => a - b);
    await writeFile(join(directory, 'report.json'), JSON.stringify({ file, synthetic: true, actualOutputAcceptance: false,
      edits: samples.length, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maximumMs: sorted.at(-1), samples, memory }, null, 2));
    console.info(`高负载历史报告：${directory}`);
    store.setProject(null, null);
  }
}, 60000);
