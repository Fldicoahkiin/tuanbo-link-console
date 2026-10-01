import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsPowerShellExecutable } from './windows-powershell';
import { ma2NetworkSetupPlanSchema, type Ma2NetworkSetupPlan } from '@tb/schema';

// IP Helper adds only a temporary unicast address. Unlike New-NetIPAddress it
// does not switch the interface from DHCP to static configuration.
export const networkAddressNativeSource = `
using System;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
public static class TblinkNetworkAddress {
  [StructLayout(LayoutKind.Explicit, Size=80)] public struct Row {
    [FieldOffset(0)] public ushort Family;
    [FieldOffset(4)] public uint Address;
    [FieldOffset(32)] public ulong Luid;
    [FieldOffset(40)] public uint Index;
    [FieldOffset(44)] public uint PrefixOrigin;
    [FieldOffset(48)] public uint SuffixOrigin;
    [FieldOffset(60)] public byte Prefix;
    [FieldOffset(61)] public byte SkipAsSource;
    [FieldOffset(64)] public uint Dad;
  }
  [DllImport("iphlpapi.dll")] static extern void InitializeUnicastIpAddressEntry(ref Row row);
  [DllImport("iphlpapi.dll")] static extern uint CreateUnicastIpAddressEntry(ref Row row);
  [DllImport("iphlpapi.dll")] static extern uint DeleteUnicastIpAddressEntry(ref Row row);
  [DllImport("iphlpapi.dll")] static extern uint GetUnicastIpAddressEntry(ref Row row);
  public static uint Change(uint index, string address, byte prefix, bool remove) {
    var row = new Row(); InitializeUnicastIpAddressEntry(ref row);
    row.Family=2; row.Index=index; row.Address=BitConverter.ToUInt32(IPAddress.Parse(address).GetAddressBytes(),0);
    row.Prefix=prefix; row.SkipAsSource=0; row.PrefixOrigin=1; row.SuffixOrigin=1; row.Dad=0;
    if(remove) {
      uint query=GetUnicastIpAddressEntry(ref row);
      if(query==1168) return 0;
      if(query!=0) return query;
      if(row.Prefix!=prefix) return 87;
      return DeleteUnicastIpAddressEntry(ref row);
    }
    uint status=CreateUnicastIpAddressEntry(ref row); if(status!=0) return status;
    for(int i=0;i<25;i++) {
      Thread.Sleep(200); status=GetUnicastIpAddressEntry(ref row);
      if(status==0 && row.Dad==4) return 0;
      if(status!=0 || row.Dad==2) break;
    }
    uint cleanup=DeleteUnicastIpAddressEntry(ref row);
    return cleanup!=0 ? 50000+cleanup : (status!=0 ? status : 183);
  }
}`;

export function networkAddressScript(plan: Ma2NetworkSetupPlan, remove: boolean): string {
  const parsed = ma2NetworkSetupPlanSchema.parse(plan);
  return `$ErrorActionPreference='Stop'
try {
  $adapter=Get-NetAdapter -InterfaceIndex ${parsed.adapter.index} -ErrorAction Stop
  if($adapter.InterfaceGuid.ToString().Trim('{}') -ne '${parsed.adapter.id}') { exit 1168 }
  Add-Type -TypeDefinition @'
${networkAddressNativeSource}
'@
  $result=[TblinkNetworkAddress]::Change(${parsed.adapter.index},'${parsed.address}',${parsed.prefix},$${remove ? 'true' : 'false'})
  exit $result
} catch { exit 1 }`;
}

export async function changeNetworkAddress(plan: Ma2NetworkSetupPlan, remove: boolean): Promise<void> {
  const script = Buffer.from(networkAddressScript(plan, remove), 'utf16le').toString('base64');
  // Only the validated plan generated in the main process becomes a command.
  const launcher = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'; $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${script}') -Wait -PassThru; Write-Output $p.ExitCode`;
  let result: string;
  try { result = (await promisify(execFile)(await windowsPowerShellExecutable(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')], { windowsHide: true })).stdout; }
  catch (error) { throw new Error('Windows 网卡配置授权未完成，请允许管理员授权后再点自动连接', { cause: error }); }
  const code = Number(result.trim());
  if (code !== 0) throw new NetworkAddressChangeError(code);
}

export class NetworkAddressChangeError extends Error {
  readonly needsRestore: boolean;
  constructor(code: number) {
    super(code >= 50000 ? `新地址校验失败，自动清理未完成（Windows ${code - 50000}）；请点击“恢复原配置”` : code === 183 || code === 5010 ? '电脑地址已被使用或冲突检测未通过，请在手动设置中换一个电脑 IP' : `网卡配置未完成（Windows ${code}），请检查网卡状态与管理员授权；原有网络配置未被覆盖`);
    this.needsRestore = code >= 50000;
  }
}
