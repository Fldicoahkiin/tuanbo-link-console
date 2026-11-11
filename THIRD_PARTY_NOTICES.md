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

## IBT / Marsyas

公开源码版本 92df3ceaa94aa73a8bf03edf751a790bc87b157f，GPL-2.0-or-later。
用于离线节拍检测，与主应用通过 WAV 和文本文件交换数据。
源码：https://github.com/marsyas/marsyas
安装资源 ibt/ 内附 COPYING、marsyas-source.zip、build.mjs 和构建记录。
未使用或分发 BeatEdit 商业插件。
## YuNet 人脸检测模型

美颜引擎使用 OpenCV Zoo 的 `face_detection_yunet_2023mar.onnx`，MIT License。
Copyright (c) 2020 Shiqi Yu。
模型来源：https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet
随安装资源 `beauty/YUNET_LICENSE.txt` 分发完整许可文本。
模型仅用于本机画面内的人脸定位，不建立成员身份档案。

## MediaPipe Selfie Multiclass Segmentation

Google LLC 的 256×256 人像语义分割模型，Apache-2.0。
使用 senty-au 发布的 ONNX 格式转换，权重固定并校验 SHA256。
原始模型卡：https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf
转换来源：https://huggingface.co/senty-au/selfie_multiclass_256x256-ONNX
完整许可和来源随 `beauty/SEMANTIC_LICENSE.txt`、`beauty/SEMANTIC_NOTICE.txt` 分发。

## ONNX Runtime DirectML

Microsoft ONNX Runtime DirectML 1.24.4，MIT License。
项目：https://github.com/microsoft/onnxruntime/tree/v1.24.4
运行时随美颜组件部署；其 LICENSE 与 ThirdPartyNotices.txt 保留在冻结运行时的 onnxruntime 资源中，包含其捆绑组件的第三方声明。

## OpenVINO

Intel OpenVINO 2024.6.0 和其依赖 openvino-telemetry 2025.2.0，Apache-2.0。
完整许可保留在冻结运行时 `_internal/openvino-2024.6.0.dist-info/LICENSE` 与
`_internal/openvino_telemetry-2025.2.0.dist-info/LICENSE` 中。
OpenVINO 用于显式启用的实例分割实验；默认美颜流程不启用该实验模型。

## RTMDet-Ins-tiny 与派生美颜遮罩模型

OpenMMLab MMDetection 3.3.0 RTMDet-Ins-tiny COCO 权重采用 Apache-2.0。
派生 ONNX 保持学习权重不变，完整许可及来源、转换说明随
`beauty/RTMDET_LICENSE.txt`、`beauty/RTMDET_NOTICE.txt` 分发。
运行不需要 PyTorch、MMCV 或训练检查点。

MediaPipe 派生皮肤概率 ONNX 在原 logits 后加入 Softmax 和皮肤通道选择，
学习权重不变，沿用 Apache-2.0；哈希和修改声明见
`beauty/SEMANTIC_NOTICE.txt`。这些派生模型的存在不表示默认启用或完整质量验收。

