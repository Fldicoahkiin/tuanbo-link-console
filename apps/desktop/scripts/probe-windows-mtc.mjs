import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'

const expectedPortName = process.argv[2] ?? '团播联动台 P1 MTC'
const captureDurationMs = Number(process.argv[3] ?? '12000')
if (!Number.isFinite(captureDurationMs) || captureDurationMs < 1000) {
  throw new Error(`无效的采集时长：${process.argv[3] ?? ''}`)
}

const application = await electron.launch({
  args: [join(process.cwd(), 'out/main/index.cjs')]
})

try {
  const window = await application.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const result = await window.evaluate(
    async ({ portName, durationMs }) => {
      const access = await navigator.requestMIDIAccess({ sysex: true })
      const input = [...access.inputs.values()].find((port) => port.name === portName)
      if (!input) throw new Error(`找不到 MIDI 输入端口：${portName}`)
      await input.open()

      const startedAt = performance.now()
      const messages = []
      input.onmidimessage = (event) => {
        const data = [...event.data]
        if (data[0] === 0xf1 && data.length >= 2) {
          messages.push({
            elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
            piece: (data[1] >> 4) & 0x07,
            value: data[1] & 0x0f
          })
        }
      }

      await new Promise((resolve) => setTimeout(resolve, durationMs))
      input.onmidimessage = null
      await input.close()

      const pieces = [...new Set(messages.map((message) => message.piece))].sort((a, b) => a - b)
      return {
        portName,
        durationMs,
        quarterFrameCount: messages.length,
        pieces,
        firstMessage: messages[0] ?? null,
        lastMessage: messages.at(-1) ?? null
      }
    },
    { portName: expectedPortName, durationMs: captureDurationMs }
  )

  console.log(JSON.stringify(result, null, 2))
  if (result.quarterFrameCount < 8 || result.pieces.length !== 8) {
    throw new Error(
      `未收到完整 MTC quarter-frame 序列：count=${result.quarterFrameCount}, pieces=${result.pieces.join(',')}`
    )
  }
} finally {
  await application.close()
}
