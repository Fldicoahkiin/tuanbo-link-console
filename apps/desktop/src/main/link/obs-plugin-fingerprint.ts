import { createHash } from 'node:crypto';

/** Ignore only PE linker/debug identity, never executable bytes, imports,
 * exports, resources or layout. Rebuilding unchanged code must not replace a
 * DLL already loaded by OBS just because LLD emitted a new build identifier. */
export function obsPluginFingerprint(binary: Buffer): string {
  const data = Buffer.from(binary);
  const range = (offset: number, length: number): void => {
    if (!Number.isInteger(offset) || offset < 0 || offset + length > data.length) throw new Error('OBS 插件 PE 文件范围无效');
  };
  range(0, 64);
  if (data.readUInt16LE(0) !== 0x5a4d) throw new Error('OBS 插件不是 Windows DLL');
  const pe = data.readUInt32LE(60); range(pe, 24);
  if (data.readUInt32LE(pe) !== 0x4550) throw new Error('OBS 插件 PE 标识无效');
  if (data.readUInt16LE(pe + 4) !== 0x8664) throw new Error('OBS 插件架构必须为 Windows x64');
  const optional = pe + 24, size = data.readUInt16LE(pe + 20), count = data.readUInt16LE(pe + 6);
  range(optional, size + count * 40);
  if (size < 168 || data.readUInt16LE(optional) !== 0x20b) throw new Error('OBS 插件必须为有效的 64 位 DLL');
  data.fill(0, pe + 8, pe + 12);
  const directory = optional + 112 + 6 * 8;
  const rva = data.readUInt32LE(directory), length = data.readUInt32LE(directory + 4);
  if (rva && length) {
    if (length % 28) throw new Error('OBS 插件调试目录无效');
    let raw: number | null = null;
    for (let i = 0; i < count; i++) {
      const section = optional + size + i * 40;
      const start = data.readUInt32LE(section + 12), bytes = data.readUInt32LE(section + 16);
      if (rva >= start && rva + length <= start + bytes) raw = data.readUInt32LE(section + 20) + rva - start;
    }
    if (raw === null) throw new Error('OBS 插件调试目录无法定位');
    range(raw, length);
    for (let entry = raw; entry < raw + length; entry += 28) {
      data.fill(0, entry + 4, entry + 8);
      const type = data.readUInt32LE(entry + 12), bytes = data.readUInt32LE(entry + 16), pointer = data.readUInt32LE(entry + 24);
      if (type === 2 && bytes >= 24) {
        range(pointer, bytes);
        if (data.toString('ascii', pointer, pointer + 4) === 'RSDS') data.fill(0, pointer + 4, pointer + 20);
      }
    }
  }
  return createHash('sha256').update(data).digest('hex');
}
