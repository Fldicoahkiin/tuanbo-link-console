import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { developmentAccessIn } from '../../../scripts/release-config.mjs'

/** electron-builder beforePack. Only an `electron-vite build --mode release` bundle may become a package: a development
 * build keeps the local test entry (TBLINK_LOCAL_TEST_ACCESS, .local-test-access) that unpackaged e2e runs rely on. */
export default async function requireReleaseBuild(context) {
  const main = join(context.packager.projectDir, 'out/main/index.cjs')
  const found = developmentAccessIn(await readFile(main))
  if (found.length > 0) {
    throw new Error(`拒绝打包开发构建：${main} 含有 ${found.join('、')}。请用 pnpm dist 或 pnpm dist:dir，它们先执行 electron-vite build --mode release`)
  }
  if (context.packager.appInfo.version !== '0.5.19') return

  const output = join(context.packager.projectDir, 'out')
  const feature = /AI 编灯|ai-lighting|link:ma2-stage-|link:lighting-model-|prepare-lighting-model\.ps1|lighting-model-assets\.json|stage-layouts/
  const resources = [context.packager.config.extraResources, context.packager.platformSpecificBuildOptions?.extraResources]
  if (feature.test(JSON.stringify(resources))) throw new Error('0.5.19 的打包资源中含有 AI 编灯组件')
  for (const file of await readdir(output, { recursive: true })) {
    if (/\.(?:[cm]?js|html|css)$/.test(file) && feature.test(await readFile(join(output, file), 'utf8'))) {
      throw new Error(`0.5.19 的 ${file} 中含有 AI 编灯组件`)
    }
  }
}
