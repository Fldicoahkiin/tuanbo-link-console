/** User-facing copy only. Preserve the original exception separately in diagnostic logs. */
export function toUserErrorMessage(error: unknown): string {
  // Electron's isolated worlds do not share Error prototypes.
  const raw = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
  const text = raw.replace(/Error invoking remote method '[^']+':\s*/g, '').replace(/\b(?:Error|TypeError|RangeError|SyntaxError):\s*/g, '').trim();
  if (/No source was found|No scene was found|specified scene does not exist/i.test(text)) return 'OBS 中找不到需要的场景或来源。请重新同步素材后再播放。';
  if (/Authentication failed|鉴权失败/i.test(text)) return 'OBS 拒绝了连接认证。请核对连接地址、端口和密码；若确认无误，请导出诊断信息以便定位。';
  if (/SystemRoot|spawn powershell|系统目录|系统命令组件/i.test(text)) return '系统命令组件暂不可用，无法检测外部程序。请重新打开联动台；若仍然失败，请导出诊断信息。';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(text)) return '无法连接目标设备。请确认程序已运行、连接服务已开启，并核对地址和端口。';
  if (/ETIMEDOUT|timed?\s*out|timeout/i.test(text)) return '操作等待超时。请检查目标程序是否正常运行，处理后再手动重试。';
  if (/EACCES|EPERM|access denied|permission denied/i.test(text)) return '当前操作没有获得所需权限。请检查文件访问权限和安全软件拦截记录。';
  if (/ENOSPC|disk full/i.test(text)) return '磁盘空间不足，操作未完成。请释放目标磁盘空间后重试。';
  if (/ENOENT|no such file|file not found/i.test(text)) return '所需文件或程序不存在。请重新选择有效路径后重试。';
  if (/EPIPE|ECONNRESET|socket closed|connection closed/i.test(text)) return '设备连接已中断。请检查目标程序和连接状态，再点击“一键连接”。';
  if (/NotAllowedError|NotReadableError/i.test(text)) return '设备访问未获允许或设备正在被占用。请检查设备权限和其他程序的占用情况。';
  if (/NotFoundError|setSinkId|AudioContext.*device .*not found/i.test(text)) return '所选音频输出设备已断开。请在音频输出设置中选择当前设备或 Windows 默认设备。';
  if (/NotSupportedError|unsupported/i.test(text)) return '当前环境不支持此操作。请检查设备、素材格式及软件版本。';
  if (/[\u3400-\u9fff]/u.test(text) && !/Command failed|\b(?:Error|Exception)\b|\bat\s+\S+\(|"(?:code|path|message)"\s*:|#< CLIXML/i.test(text) && !/\b[A-Z_]{5,}\b/.test(text)) return text;
  return '操作未能完成。请导出诊断信息以便定位后再尝试，避免重复操作。';
}
