# 离线音乐模型测试包

本包用于用户明确要求的功能测试，包含 Python 3.11.9、PyTorch/torchaudio 2.7.1 CPU、Beat This! final0/1/2、All-In-One harmonix-all 八折模型与 HTDemucs。安装后无需系统 Python、Git、编译器或在线下载，界面明确显示 CPU。没有 GPU 自动回退行为。

模型来源、固定摘要及原始许可标记见 `models/manifest.json`；运行时逐文件摘要见 `runtime-manifest.json`。Python 许可保存在 `runtime/LICENSE.txt`，第三方依赖的许可及元数据保存在 `runtime/Lib/site-packages/*.dist-info`，上游整合说明保存在 `licenses`。不包含用户音源。

2026-10-08 重新核查：All-In-One 作者模型页 https://huggingface.co/taejunkim/allinone/blob/main/README.md 标注 MIT，作者代码 https://github.com/mir-aidj/all-in-one/blob/main/LICENSE 为 MIT；所用社区推理版 checkpoints.toml 仍标注 CC-BY-NC-SA-4.0。此包完整保留双方信息及许可文件，不把这次内部功能测试作为商业再分发许可冲突已获澄清的证明。未经进一步许可核查，不应作为商业模型发行包转售或推广。

模型能运行不代表精度通过：真实曲库校准、独立盲测、五分钟音源耗时目标尚未验收。CPU 速度取决于电脑，长曲可能触发明确的分析超时；不会偷偷切换引擎、联网或提交半成品。
