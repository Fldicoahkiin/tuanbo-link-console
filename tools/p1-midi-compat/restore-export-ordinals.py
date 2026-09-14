"""Restore system winmm ordinals after MinGW linker forwarder allocation.

Usage: python restore-export-ordinals.py system-winmm.dll built-winmm.dll
Requires pefile. Only changes the newly built compatibility DLL.
"""
import struct
import sys
from pathlib import Path
import pefile

reference = pefile.PE(sys.argv[1])
target_path = Path(sys.argv[2])
target = pefile.PE(str(target_path))
expected = reference.DIRECTORY_ENTRY_EXPORT.symbols
actual = target.DIRECTORY_ENTRY_EXPORT.symbols
addresses = {entry.name: entry.address for entry in actual}
base = min(entry.ordinal for entry in expected)
count = max(entry.ordinal for entry in expected) - base + 1
directory = target.DIRECTORY_ENTRY_EXPORT.struct
assert count <= directory.NumberOfFunctions
data = bytearray(target_path.read_bytes())
function_table = target.get_offset_from_rva(directory.AddressOfFunctions)
ordinals = {}
for entry in expected:
    name = entry.name or f'ordinal{entry.ordinal}'.encode()
    assert name in addresses, name
    struct.pack_into('<I', data, function_table + (entry.ordinal - base) * 4, addresses[name])
    ordinals[name] = entry.ordinal - base
name_table = target.get_offset_from_rva(directory.AddressOfNames)
ordinal_table = target.get_offset_from_rva(directory.AddressOfNameOrdinals)
for index in range(directory.NumberOfNames):
    rva = struct.unpack_from('<I', data, name_table + index * 4)[0]
    name = target.get_string_at_rva(rva)
    assert name in ordinals, name
    struct.pack_into('<H', data, ordinal_table + index * 2, ordinals[name])
struct.pack_into('<I', data, directory.get_field_absolute_offset('Base'), base)
struct.pack_into('<I', data, directory.get_field_absolute_offset('NumberOfFunctions'), count)
target.close()
target_path.write_bytes(data)
verified = pefile.PE(str(target_path))
by_ordinal = {entry.ordinal: entry for entry in verified.DIRECTORY_ENTRY_EXPORT.symbols}
assert all(entry.ordinal in by_ordinal for entry in expected)
print(f'Preserved {len(expected)} original export ordinals')
