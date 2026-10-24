import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { musicWorkerFiles, verifyMusicRelease } from '../../../tools/music-analysis/release-pin.mjs';

/** The official package ships the offline music-analysis runtime: Python, packages, models and licenses must be the
 * pinned ones and the worker modules this commit's. A missing or different runtime fails the build. */
export default async function verifyMusicResources(context) {
  if (context.electronPlatformName !== 'win32') return;
  const packaged = join(context.appOutDir, 'resources/music-analysis');
  const tree = await verifyMusicRelease(packaged);
  const repository = join(context.packager.projectDir, '../../tools/music-analysis');
  for (const name of musicWorkerFiles) {
    if (!(await readFile(join(packaged, name))).equals(await readFile(join(repository, name)))) throw new Error(`音乐分析模块与本次提交不一致：${name}`);
  }
  console.log(`音乐分析运行时校验通过：固定部分 ${tree.files} 个文件，模块 ${musicWorkerFiles.length} 个`);
}
