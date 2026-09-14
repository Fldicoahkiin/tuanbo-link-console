import { copyFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

const portName = process.argv[2] ?? '团播联动台 P1 MTC'
const projectPath = process.argv[3]
if (!projectPath) throw new Error('必须提供已保存的 .tblink 工程路径')
const sourceUserDataDirectory = process.env.TUANBO_USER_DATA_PATH ?? join(process.env.APPDATA ?? '', '团播联动台')
const userDataDirectory = await mkdtemp('C:\\dev\\tuanbo-mtc-runtime-probe-')
const integrationDirectory = join(userDataDirectory, 'link-integrations')
await mkdir(integrationDirectory, { recursive: true })
await copyFile(join(sourceUserDataDirectory, 'link-integrations', 'profile.json'), join(integrationDirectory, 'profile.json'))
const application = await electron.launch({
  args: [`--user-data-dir=${userDataDirectory}`, join(process.cwd(), 'out/main/index.cjs')]
})

try {
  const userDataPath = await application.evaluate(({ app }) => app.getPath('userData'))
  const window = await application.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate((path) => localStorage.setItem('tblink.last-project-path.v1', path), projectPath)
  await window.reload({ waitUntil: 'domcontentloaded' })
  await window.locator('.toolbar-project').filter({ hasText: projectPath }).waitFor({ state: 'visible', timeout: 10_000 })
  const profile = await window.evaluate(async () => {
    const value = await window.tbLink.loadIntegrationProfile()
    return value ? {
      profileId: value.profileId,
      mtcInputPortProfileId: value.p1.mtcInputPortProfileId,
      midiPorts: value.midiPortProfiles
    } : null
  })
  await window.waitForTimeout(1_000)
  const setCurrentItem = window.getByRole('button', { name: '设为当前节目' }).first()
  if (await setCurrentItem.isVisible()) await setCurrentItem.click()
  await window.getByRole('button', { name: /集成中心/ }).click()
  const launch = window.getByRole('button', { name: '启动设备并准备跟随 P1' })
  if (await launch.isDisabled()) throw new Error('集成中心尚未满足启动条件：请检查当前节目和本机集成档案')
  await launch.click()

  const result = await window.evaluate(async (expectedPortName) => {
    const access = await navigator.requestMIDIAccess({ sysex: true })
    const output = [...access.outputs.values()].find((port) => port.name === expectedPortName)
    if (!output) throw new Error(`找不到 MIDI 输出端口：${expectedPortName}`)
    await output.open()

    const frameRate = 30
    const messageCount = frameRate * 8 * 20
    const startedAt = performance.now() + 100
    for (let index = 0; index < messageCount; index += 1) {
      const absoluteFrame = Math.floor(index / 8)
      const piece = index % 8
      const frames = absoluteFrame % frameRate
      const seconds = Math.floor(absoluteFrame / frameRate) % 60
      const values = [frames & 0x0f, (frames >> 4) & 0x01, seconds & 0x0f, (seconds >> 4) & 0x03, 0, 0, 0, 0x06]
      output.send([0xf1, (piece << 4) | values[piece]], startedAt + index * (1000 / (frameRate * 8)))
    }

    await new Promise((resolve) => setTimeout(resolve, 4_000))
    const operatorState = globalThis.document.querySelector('.operator-state strong')?.textContent?.trim() ?? ''
    const mtcStatus = [...globalThis.document.querySelectorAll('.security-banner strong')]
      .map((row) => row.textContent?.trim() ?? '')
      .find((text) => text.startsWith('MTC')) ?? ''
    const notices = [...globalThis.document.querySelectorAll('.toast')].map((row) => row.textContent?.trim() ?? '')
    await output.close()
    return { portName: expectedPortName, messageCount, operatorState, mtcStatus, notices }
  }, portName)

  console.log(JSON.stringify({ userDataPath, profile, ...result }, null, 2))
  if (!['待命', '跟随中'].includes(result.operatorState) || result.mtcStatus !== 'MTC 已连接') {
    throw new Error(`联动台未按新流程进入 P1 跟随：operatorState=${result.operatorState}, mtcStatus=${result.mtcStatus}`)
  }
} finally {
  await application.close()
}
