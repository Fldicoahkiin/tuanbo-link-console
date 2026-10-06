import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBeautyDistribution } from '../../../tools/obs/beauty/distribution.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export default async function verifyBeautyResources(context) {
  if (context.electronPlatformName !== 'win32') return;
  const packaged = context.appOutDir ? join(context.appOutDir, 'resources/beauty') : undefined;
  const result = await verifyBeautyDistribution(join(root, 'tools/obs/beauty'), join(root, 'artifacts/beauty-prototype'), packaged);
  console.log(`美颜分发资源校验通过：${result.files} 个文件`);
}

