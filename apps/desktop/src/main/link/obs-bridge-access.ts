/** Windows ERROR_ACCESS_DENIED reaches Node as EPERM. Older OBS plugin pipes admitted only their owner, and an
 * OBS started as administrator is owned by the Administrators group, so a normal-privilege console was refused.
 * The current plugin also admits the same Windows user; a refusal now means an old plugin or another account. */
export function isPipeAccessDenied(error: Error): boolean {
  return 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES');
}

export const obsPipeAccessDeniedMessage = 'Windows 拒绝联动台访问 OBS 内置组件。OBS 以管理员身份运行时需要新版组件：'
  + '请点击“检查并修复组件”完成升级（需要先在 OBS 里正常退出）。已经升级仍出现时，请确认 OBS 和联动台是用同一个 Windows 账户打开的。';

/** The beauty plugin is a separately pinned build that still admits only its owner. */
export const beautyPipeAccessDeniedMessage = 'Windows 拒绝联动台访问 OBS 美颜通道，通常是因为 OBS 以管理员身份运行，美颜组件暂不支持这种方式。'
  + '请用普通方式打开 OBS 后再使用美颜；预览、定位和其他功能不受影响。';
