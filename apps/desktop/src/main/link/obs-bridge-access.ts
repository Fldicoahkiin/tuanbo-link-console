/** Windows ERROR_ACCESS_DENIED reaches Node as EPERM. The OBS plugin pipes admit only their owner, and an
 * OBS started as administrator is owned by the Administrators group, so a normal-privilege console is refused. */
export function isPipeAccessDenied(error: Error): boolean {
  return 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES');
}

export const obsPipeAccessDeniedMessage = 'Windows 拒绝联动台访问 OBS 内置组件，通常是因为 OBS 以管理员身份运行而联动台没有。'
  + '请在 OBS 里正常退出，再用普通方式打开 OBS（不要选“以管理员身份运行”，虚拟摄像头可以照常开启），然后重新连接。';
