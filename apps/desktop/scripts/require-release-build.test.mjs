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
  return { packager: { projectDir: directory, appInfo: { version: '0.5.19' }, config: {} } }
}

test('打包只接受 release 构建：开发构建的本机测试入口一律拒绝', async () => {
  for (const development of ['localTestAccessEnabled(app.isPackaged, process.env.TBLINK_LOCAL_TEST_ACCESS)', "existsSync(join(app.getAppPath(), '.local-test-access'))", 'message: "本机开发测试通道已启用；此状态不是正式激活授权"']) {
    await assert.rejects(requireReleaseBuild(await project(development)), /拒绝打包开发构建/)
  }
  await assert.rejects(requireReleaseBuild(await project(undefined)), /ENOENT/)
  await requireReleaseBuild(await project('const getLicenseStatus = async () => (await getLicenseService()).status();'))
})

test('0.5.19 的资源、控台接口和异步页面都按稳定版范围核对', async () => {
  const context = await project('const ready = true')
  const output = join(context.packager.projectDir, 'out')
  await mkdir(join(output, 'renderer/assets'), { recursive: true })
  const chunk = join(output, 'renderer/assets/panel.js')
  await writeFile(chunk, 'const page = "ai-lighting"')
  await assert.rejects(requireReleaseBuild(context), /panel\.js 中含有 AI 编灯/)
  await writeFile(chunk, 'const page = "lighting"')
  context.packager.config.extraResources = [{ from: '../scripts', filter: ['prepare-lighting-model.ps1'] }]
  await assert.rejects(requireReleaseBuild(context), /打包资源中含有 AI 编灯/)
  context.packager.config.extraResources = []
  await requireReleaseBuild(context)
  await writeFile(join(output, 'main/index.cjs'), 'handle("link:ma2-stage-open")')
  await assert.rejects(requireReleaseBuild(context), /index\.cjs 中含有 AI 编灯/)
})
