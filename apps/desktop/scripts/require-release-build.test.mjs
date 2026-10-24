import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import requireReleaseBuild from './require-release-build.mjs'

async function project(main) {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-pack-'))
  if (main !== undefined) {
    await mkdir(join(directory, 'out/main'), { recursive: true })
    await writeFile(join(directory, 'out/main/index.cjs'), main)
  }
  return { packager: { projectDir: directory } }
}

test('打包只接受 release 构建：开发构建的本机测试入口一律拒绝', async () => {
  for (const development of ['localTestAccessEnabled(app.isPackaged, process.env.TBLINK_LOCAL_TEST_ACCESS)', "existsSync(join(app.getAppPath(), '.local-test-access'))", 'message: "本机开发测试通道已启用；此状态不是正式激活授权"']) {
    await assert.rejects(requireReleaseBuild(await project(development)), /拒绝打包开发构建/)
  }
  await assert.rejects(requireReleaseBuild(await project(undefined)), /ENOENT/)
  await requireReleaseBuild(await project('const getLicenseStatus = async () => (await getLicenseService()).status();'))
})
