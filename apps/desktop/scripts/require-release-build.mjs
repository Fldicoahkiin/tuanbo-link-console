import { readFile } from 'node:fs/promises'
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
}
