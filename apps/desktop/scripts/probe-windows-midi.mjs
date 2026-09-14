import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { _electron as electron } from '@playwright/test'

const expectedPortName = process.argv[2] ?? '团播联动台 P1 MTC'
const userData = await mkdtemp(join(tmpdir(), 'tblink-midi-probe-'))
const application = await electron.launch({
  args: [`--user-data-dir=${userData}`, join(process.cwd(), 'out/main/index.cjs')]
})

try {
  const window = await application.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const result = await window.evaluate(async () => {
    const access = await navigator.requestMIDIAccess({ sysex: true })
    return {
      sysexEnabled: access.sysexEnabled,
      inputs: [...access.inputs.values()].map((port) => ({
        id: port.id,
        name: port.name,
        state: port.state,
        connection: port.connection
      })),
      outputs: [...access.outputs.values()].map((port) => ({
        id: port.id,
        name: port.name,
        state: port.state,
        connection: port.connection
      }))
    }
  })

  console.log(JSON.stringify(result, null, 2))
  const inputReady = result.inputs.some((port) => port.name === expectedPortName && port.state === 'connected')
  const outputReady = result.outputs.some((port) => port.name === expectedPortName && port.state === 'connected')
  if (expectedPortName !== '--list' && (!result.sysexEnabled || !inputReady || !outputReady)) {
    throw new Error(`MIDI 端口未完整就绪：${expectedPortName}`)
  }
} finally {
  await application.close()
}
