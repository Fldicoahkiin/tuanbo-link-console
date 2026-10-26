/** User-facing copy only. Preserve the original exception separately in diagnostic logs. */
export function toUserErrorMessage(error: unknown): string {
  // Electron's isolated worlds do not share Error prototypes.
  const raw = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
  const text = raw.replace(/Error invoking remote method '[^']+':\s*/g, '').replace(/\b(?:Error|TypeError|RangeError|SyntaxError):\s*/g, '').trim();
  // Preload translates once and views translate again; keep the first result.
  if (/^(?:连接配置校验失败|操作未能完成|所需文件或程序不存在)[:：]/.test(text)) return text;
  if (/Another network request is pending/.test(text)) return '控台上一次的读取还没结束。请不要重复读取，等两分钟后再手动读取；已有素材不受影响。';
  if (/Authentication.*(?:required|failed)|鉴权失败/i.test(text)) return 'OBS 需要密码，或者密码不对。请在 OBS 的“工具 → WebSocket 服务器设置”里查看密码，填到联动台的“OBS 密码”里，保存后再连接。';
  if (/Invalid URL|Invalid url|ERR_INVALID_URL/i.test(text)) return 'OBS 地址格式不正确，请填写完整地址，例如 ws://127.0.0.1:4455。';
  if (/^音频解码或读取失败[:：]/.test(text)) return '无法读取这个音频。请检查文件是否损坏、格式是否支持，换一个音频文件后重新播放。';
  if (/No source was found|No scene was found|specified scene does not exist/i.test(text)) return 'OBS 中找不到需要的场景或来源。请重新同步素材后再播放。';
  if (/SystemRoot|spawn powershell|系统目录|系统命令组件/i.test(text)) return '系统命令暂时用不了，无法检测外部程序。请重新打开联动台；还是不行的话，请导出诊断包发给售后。';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/i.test(text)) return '连不上目标设备。请确认程序已经打开、连接服务已开启，并检查地址和端口。';
  if (/ETIMEDOUT|timed?\s*out|timeout/i.test(text)) return '操作超时了。请检查目标程序是否正常运行，处理后再试。';
  if (/EACCES|EPERM|access denied|permission denied/i.test(text)) return '没有权限完成这个操作。请检查文件权限，或杀毒软件是否拦截。';
  if (/ENOSPC|disk full/i.test(text)) return '磁盘空间不够，操作没有完成。请清理磁盘空间后再试。';
  if (/ENOENT|no such file|file not found/i.test(text)) {
    const missing = /spawn (.+?) ENOENT|ENOENT[^']*'([^']+)'/.exec(text);
    return `所需文件或程序不存在${missing ? `：${missing[1] ?? missing[2]}` : ''}。请重新选择正确的位置后再试。`;
  }
  if (/EPIPE|ECONNRESET|socket closed|connection closed/i.test(text)) return '设备连接断开了。请检查目标程序和连接状态，再点“一键连接”。';
  if (/NotAllowedError|NotReadableError/i.test(text)) return '设备没有被允许访问，或正被其他程序占用。请检查设备权限，并关掉占用它的程序。';
  if (/NotFoundError|setSinkId|AudioContext.*device .*not found/i.test(text)) return '选择的音频输出设备已断开。请在音频输出设置里重新选择设备，或改用 Windows 默认设备。';
  if (/NotSupportedError|unsupported/i.test(text)) return '当前环境不支持这个操作。请检查设备、素材格式和软件版本。';
  if (/[\u3400-\u9fff]/u.test(text) && !/Command failed|\b(?:Error|Exception)\b|\bat\s+\S+\(|"(?:code|path|message)"\s*:|#< CLIXML/i.test(text) && !/\b[A-Z_]{5,}\b/.test(text)) return text;
  return `操作未能完成：${leadingReason(text)}`;
}

/**
 * Schema failures arrive as a JSON issue list whose first line is just "["; show the first issue and
 * the field it names, so a bare "Invalid input" still says which value was refused. The list is
 * indented by two, so the first issue's own keys sit four spaces in, ahead of any nested union errors.
 */
function leadingReason(text: string): string {
  const first = text.split('\n')[0]?.trim() ?? '';
  const issues = /^[[{]$/.test(first);
  const string = '"(?:[^"\\\\]|\\\\.)*"';
  const message = issues ? (new RegExp(`\\n {4}"message"\\s*:\\s*(${string})`).exec(text) ?? new RegExp(`"message"\\s*:\\s*(${string})`).exec(text))?.[1] : undefined;
  const decoded: unknown = message ? JSON.parse(message) : undefined;
  if (typeof decoded !== 'string') return first.slice(0, 300) || '未返回错误内容';
  // Only a list of JSON strings and integers matches, so parsing it cannot fail.
  const item = `(?:${string}|\\d+)`;
  const listed = new RegExp(`\\n {4}"path"\\s*:\\s*\\[\\s*(${item}(?:\\s*,\\s*${item})*)?\\s*\\]`).exec(text);
  const path: unknown = listed ? JSON.parse(`[${listed[1] ?? ''}]`) : [];
  const field = Array.isArray(path) ? path.map(String).join('.') : '';
  return `${decoded}${field ? `（字段 ${field}）` : ''}`.slice(0, 300);
}
