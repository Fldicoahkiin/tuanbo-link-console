import { spawn } from 'node:child_process';
import { ffmpegDeadline } from './ffmpeg-deadline';

// Intra lossless HEVC makes common 8-bit 4:2:0 media eligible for OBS hardware
// decoding without tying cache generation to a particular GPU. Other formats
// keep Ut Video / FFV1 to preserve their chroma, bit depth and alpha. OBS's
// frame-threaded
// decoder needs lookahead even for a paused seek. Guard frames repeat only the
// last picture, beyond the original asset duration; timeline bounds and audio
// remain those of the original. Higher bit depths / alpha keep FFV1.
export function obsSeekEncoding(pixelFormat: string, decode: 'hardware' | 'software' = 'hardware'): string[] {
  if (!pixelFormat || /[^a-z0-9]/.test(pixelFormat)) throw new Error('无法识别素材像素格式，未生成定位缓存');
  // Neither encoder accepts packed 8-bit RGB such as QuickTime Animation's
  // argb. Reorder to a layout holding identical samples: alpha goes to FFV1
  // bgra (gbrap conversion rounds alpha by one), opaque RGB to planar gbrp.
  const reordered = packedRgbLayouts[pixelFormat];
  const utVideo = reordered === 'gbrp' || ['yuv420p', 'yuv422p', 'yuv444p', 'gbrp', 'gbrap'].includes(pixelFormat);
  return [...(pixelFormat === 'yuv420p' && decode === 'hardware' ? ['-c:v', 'libx265', '-preset', 'ultrafast',
    '-x265-params', 'lossless=1:keyint=1:bframes=0:pools=2:frame-threads=1'] : utVideo ? ['-c:v', 'utvideo']
    : ['-c:v', 'ffv1', '-level', '3', '-g', '1']),
    '-pix_fmt', reordered ?? '+', '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-threads', '2'];
}

const packedRgbLayouts: Readonly<Record<string, 'bgra' | 'gbrp'>> = {
  argb: 'bgra', rgba: 'bgra', abgr: 'bgra',
  rgb24: 'gbrp', bgr24: 'gbrp', '0rgb': 'gbrp', rgb0: 'gbrp', '0bgr': 'gbrp'
};

/** Decode one frame with the same bundled FFmpeg used by the encoder. Reading
 * the filter's format avoids guessing from file extensions or codec names. */
export function inspectObsSeekPixelFormat(executable: string, source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-hide_banner', '-loglevel', 'info', '-threads', '2', '-filter_threads', '1',
      '-i', source, '-map', '0:v:0', '-vf', 'showinfo', '-frames:v', '1', '-an', '-sn', '-dn', '-f', 'null', '-'],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpegDeadline(child, '读取素材像素格式', 60_000, reject);
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { output = (output + chunk).slice(-16000); });
    child.once('error', error => reject(new Error(`读取素材像素格式失败：${error.message}`, { cause: error })));
    child.once('close', code => {
      const format = /\[Parsed_showinfo_[^\]]+\]\s+n:\s*0\s+.*?\bfmt:([a-z0-9]+)\b/.exec(output)?.[1];
      if (code !== 0 || !format) reject(new Error(`读取素材像素格式失败（${code}）：${output.slice(-2000)}`));
      else resolve(format);
    });
  });
}
