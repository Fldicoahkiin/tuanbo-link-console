# 第三方组件声明

## FFmpeg

团播联动台使用 `ffmpeg-static` 5.3.0 提供的 FFmpeg 6.1.1 Windows x64 可执行文件，
用于把浏览器不能直接解码的 HEVC 等素材生成 H.264/AAC 编辑代理。

- FFmpeg 项目：https://ffmpeg.org/
- ffmpeg-static：https://github.com/eugeneware/ffmpeg-static
- 本次 Windows 静态构建采用 GPL-3.0-or-later；随包保留 `ffmpeg.exe.LICENSE` 与 `ffmpeg.exe.README`。

原始媒体不会被替换。生成的代理只用于团播联动台内的参考画布、时间线定位和试听。
