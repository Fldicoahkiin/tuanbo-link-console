import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyMusicRelease } from '../../../tools/music-analysis/release-pin.mjs';

/** The official package does not ship the offline music-analysis runtime yet; when one is packaged it must be the pinned one. */
export default async function verifyMusicResources(context) {
  if (context.electronPlatformName !== 'win32') return;
  const packaged = join(context.appOutDir, 'resources/music-analysis');
  if (!existsSync(packaged)) return;
  const tree = await verifyMusicRelease(packaged);
  console.log(`音乐分析运行时校验通过：${tree.files} 个文件`);
}
