import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Normal WM_CLOSE only, on the exact test process recorded at launch. Hidden
 * OBS windows aren't exposed by Process.MainWindowHandle/CloseMainWindow. */
export async function closeOwnedObsTest(identity) {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || typeof identity.executable !== 'string' || typeof identity.started !== 'string') throw new Error('Invalid owned OBS identity');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
$p=Get-Process -Id ${identity.pid};
if(-not $p.MainModule.FileName.Equals(${quote(identity.executable)},[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime().ToString('o') -ne ${quote(identity.started)}){throw 'Process identity changed'};
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public class CloseOwnedAudioObs { public delegate bool E(IntPtr h,IntPtr p); [DllImport("user32.dll")] static extern bool EnumWindows(E e,IntPtr p); [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h,int index); [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); public static bool Close(uint pid){ IntPtr main=IntPtr.Zero,dialog=IntPtr.Zero;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id!=pid)return true;var s=new StringBuilder(512);GetWindowText(h,s,512);if(s.ToString().StartsWith("OBS ")){main=h;return false;}if(s.Length>0 && (GetWindowLongPtr(h,-16).ToInt64() & 0x00C00000L)==0x00C00000L)dialog=h;return true;},IntPtr.Zero);var target=main!=IntPtr.Zero?main:dialog;return target!=IntPtr.Zero && PostMessage(target,16,IntPtr.Zero,IntPtr.Zero);}}';
if(-not [CloseOwnedAudioObs]::Close(${identity.pid})){throw 'Test OBS refused normal close; retained'};
if(-not $p.WaitForExit(15000)){throw 'Test OBS did not exit; retained'}`;
  await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 25000 });
}
