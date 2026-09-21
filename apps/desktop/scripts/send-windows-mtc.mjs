import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

const portName = process.argv[2] ?? '团播联动台 P1 MTC'
const durationSeconds = Number(process.argv[3] ?? '12')

if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
  throw new Error(`发送时长必须是 1 到 300 秒的整数：${process.argv[3] ?? ''}`)
}

const application = await electron.launch({
  args: [join(process.cwd(), 'out/main/index.cjs')]
})

try {
  const window = await application.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const result = await window.evaluate(
    async ({ expectedPortName, seconds }) => {
      const access = await navigator.requestMIDIAccess({ sysex: true })
      const output = [...access.outputs.values()].find((port) => port.name === expectedPortName)
      if (!output) throw new Error(`找不到 MIDI 输出端口：${expectedPortName}`)
      await output.open()

      const frameRate = 30
      const quarterFramesPerSecond = frameRate * 4
      const intervalMs = 1000 / quarterFramesPerSecond
      const messageCount = seconds * quarterFramesPerSecond
      const startedAt = performance.now() + 100

      for (let index = 0; index < messageCount; index += 1) {
        // Eight pieces describe one snapshot over two media frames.
        const absoluteFrame = Math.floor(index / 8) * 2
        const piece = index % 8
        const frames = absoluteFrame % frameRate
        const totalSeconds = Math.floor(absoluteFrame / frameRate)
        const secondsPart = totalSeconds % 60
        const minutes = Math.floor(totalSeconds / 60) % 60
        const hours = Math.floor(totalSeconds / 3600) % 24
        const values = [
          frames & 0x0f,
          (frames >> 4) & 0x01,
          secondsPart & 0x0f,
          (secondsPart >> 4) & 0x03,
          minutes & 0x0f,
          (minutes >> 4) & 0x03,
          hours & 0x0f,
          ((hours >> 4) & 0x01) | 0x06
        ]
        output.send([0xf1, (piece << 4) | values[piece]], startedAt + index * intervalMs)
      }

      await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 250))
      await output.close()
      return { portName: expectedPortName, seconds, frameRate, messageCount }
    },
    { expectedPortName: portName, seconds: durationSeconds }
  )
  console.log(JSON.stringify(result, null, 2))
} finally {
  await application.close()
}
