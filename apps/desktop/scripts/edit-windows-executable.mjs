import { join } from 'node:path'
import { rcedit } from 'rcedit'
import verifyBeautyResources from './verify-beauty-resources.mjs'
import verifyMusicResources from './verify-music-resources.mjs'

export default async function editWindowsExecutable(context) {
  if (context.electronPlatformName !== 'win32') {
    return
  }
  await verifyBeautyResources(context)
  await verifyMusicResources(context)

  const executablePath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  )
  const version = context.packager.appInfo.version
  const productName = context.packager.appInfo.productName

  const options = {
    'file-version': version,
    'product-version': `${version}.0`,
    'version-string': {
      CompanyName: productName,
      FileDescription: productName,
      InternalName: productName,
      LegalCopyright: `Copyright © 2026 ${productName}`,
      OriginalFilename: '',
      ProductName: productName
    },
    icon: join(context.packager.buildResourcesDir, 'icon.ico')
  }

  await writeMetadataWithBoundedFileLockRetry(executablePath, options)

  console.log(`Windows executable metadata written: ${executablePath}`)
}

async function writeMetadataWithBoundedFileLockRetry(executablePath, options) {
  const maxAttempts = 5
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rcedit(executablePath, options)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isTransientCommitFailure = message.includes('Unable to commit changes')
      if (!isTransientCommitFailure || attempt === maxAttempts) {
        throw error
      }

      const delayMilliseconds = attempt * 1000
      console.warn(
        `Windows executable is still held after ASAR integrity update; rcedit attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMilliseconds}ms.`
      )
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds))
    }
  }

  throw new Error('Windows executable metadata retry loop ended unexpectedly')
}
