# 第三方组件声明

## Windows 打包链 ZIP 防护

开发及打包依赖 `extract-zip` 2.0.1 使用仓库补丁 `patches/extract-zip@2.0.1.patch`。
Windows 发布归档仅允许普通文件和目录，拒绝归档符号链接及目标路径中已有的链接，
防止 GHSA-jmr9-qjv8-65gv、GHSA-7pqw-9j4j-h8q3 所述的越界写入。
补丁保留普通文件覆盖，随 pnpm 锁文件应用；不用于提供跨平台通用 ZIP 解压服务。
上游尚无修复版本，依赖审计仍会报告这两条记录；不得据此宣称原版库已修复。

## FFmpeg

团播联动台使用 `ffmpeg-static` 5.3.0 提供的 FFmpeg 6.1.1 Windows x64 可执行文件，
用于把浏览器不能直接解码的 HEVC 等素材生成 H.264/AAC 编辑代理。

- FFmpeg 项目：https://ffmpeg.org/
- ffmpeg-static：https://github.com/eugeneware/ffmpeg-static
- 本次 Windows 静态构建采用 GPL-3.0-or-later；随包保留 `ffmpeg.exe.LICENSE` 与 `ffmpeg.exe.README`。

原始媒体不会被替换。生成的代理只用于团播联动台内的参考画布、时间线定位和试听。

## WaveSurfer.js

版本：7.12.12。用于波形与频谱显示。
项目：https://github.com/katspaugh/wavesurfer.js

BSD 3-Clause License

Copyright (c) 2012-2023, katspaugh and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## IBT / Marsyas

公开源码版本 92df3ceaa94aa73a8bf03edf751a790bc87b157f，GPL-2.0-or-later。
用于离线节拍检测，与主应用通过 WAV 和文本文件交换数据。
源码：https://github.com/marsyas/marsyas
安装资源 ibt/ 内附 COPYING、marsyas-source.zip、build.mjs 和构建记录。
未使用或分发 BeatEdit 商业插件。
