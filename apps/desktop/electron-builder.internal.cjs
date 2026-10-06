const { build } = require('./package.json');

module.exports = {
  ...build,
  appId: 'com.tuanbo.control.internal',
  productName: '团播联动台内测',
  extraMetadata: { name: 'tuanbo-link-internal', productName: '团播联动台内测' },
  directories: { ...build.directories, output: 'dist-internal' },
  files: [{ from: 'out-internal', to: 'out', filter: ['**/*', '!**/*.map'] }, 'build/icon.ico', 'package.json'],
  publish: null,
  win: { ...build.win, artifactName: 'Tuanbo-Link-Internal-${version}-${arch}.${ext}' },
  nsis: { ...build.nsis, shortcutName: '团播联动台内测', uninstallDisplayName: '团播联动台内测' }
};
