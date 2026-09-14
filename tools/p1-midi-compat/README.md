# P1 MIDI 兼容模块

这是本机验证的 P1 1.14.2 输出枚举兼容模块，不是时间码播放器。

构建工具：Zig 0.13.0 x86_64-windows-gnu、Python pefile。C 源码为 winmm.c。生成 .def 时遍历本机 System32/winmm.dll 的全部导出：midiOutGetDevCapsW 指向 tblinkMidiOutGetDevCapsW，其他名称转发至 tblink_winmm_system 的同名导出；无名称导出使用 ordinalN 并转发至 #N。保留原序号。

```powershell
zig cc -target x86_64-windows-gnu -shared -O2 winmm.c winmm.def -o winmm.dll
python restore-export-ordinals.py C:/Windows/System32/winmm.dll winmm.dll
```

MinGW 转发导出的序号分配与 .def 声明不同，后处理只修正新构建 DLL 的导出表，不修改 P1 或 Windows 二进制文件。再次构建后必须更新安装脚本中的模块摘要，并重新验证所有导出按名称、序号可解析，以及 0/76/84 字节查询不写越缓冲区。

将 DLL 与 install.ps1 放在同一目录。脚本仅支持本次核对过摘要的 P1 和 Windows 系统库，拒绝覆盖未知模块。安装和移除都要求先正常退出 P1。Windows 系统库只在安装时从本机复制，不分发。

已安装本机无需再运行脚本。操作员只需在 P1 MIDI 输出中选择“团播联动台 P1 MTC”。详见 docs/P1_MIDI_COMPATIBILITY.md。
