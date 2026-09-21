# IBT 节拍检测

使用 Marsyas 的 IBT 离线检测程序，固定上游版本：
`92df3ceaa94aa73a8bf03edf751a790bc87b157f`。
来源：https://github.com/marsyas/marsyas 。未修改上游检测源码，未使用 BeatEdit 商业包中的文件。

## 构建

Windows x64，需要 Node、Git、Python（含 pip）。仓库根目录运行 `node tools/ibt/build.mjs`。
脚本使用 Zig 0.14.1、CMake 4.4.3 和 Ninja 1.13.2。首次联网获取依赖，后续校验已构建程序的摘要后复用。
关闭音频/MIDI 设备、GUI 和脚本模块，保留 WAV 文件输入及离线 IBT。

运行：在包含 `input.wav` 的工作目录执行 `ibt.exe -off -o beats input.wav beats.txt`。
输入由应用转换为单声道 44100Hz PCM16 WAV；输出每行是秒数，之后可能有瞬时 BPM。
使用相对文件名以避免旧版 C++ 文件 API 的中文路径问题。应用负责静音检查与结果校验。
IBT 对静音也会外推节拍，故应用排除全部采样幅度不超过 3/32768 的静音。

## 许可与分发

IBT/Marsyas 为 GPL-2.0-or-later；其第三方组件许可位于原始源码中。
安装资源包含完整上游对应源码 `marsyas-source.zip`、COPYING、本构建脚本和版本记录。
可以将源码解压后按脚本中的 CMake 参数重新构建；无需 BeatEdit 或 Resolve。
此许可不等于 Mamoworld 的商业授权。项目正式分发仍需整体审核 GPL 义务。

IBT 输出是节拍预测，不承诺识别音乐段落、舞蹈动作、第一强拍或必然与 BeatEdit 商业版相同。
