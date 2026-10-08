# 2026-10-06 免激活功能测试安装包

用户要求将软件交给其他主机测试，且无需激活码。本次明确增加构建期 `portable-test` 渠道，取代该测试包原有的本机绑定限制；保留正式发行和签名本机内测渠道原有规则。测试渠道不设到期日。

- 测试包：`D:/Tuanbo-Test-NoActivation-20261006/Tuanbo-Link-Test-NoActivation-0.4.41-x64.exe`
- SHA256：`0EE7D73D963932BA44807318909803C89EAFB68181CE783B3972983A9E80F10A`
- 独立 appId：`com.tuanbo.control.functionaltest`。
- 安装、快捷方式及配置名称：团播联动台功能测试版。
- 正式更新源在本渠道禁用。运行时环境变量或旁置文件不能为正式构建启用该渠道。
- 未提交或推送，未覆盖原工程和现有验收构建。

构建：`node scripts/build-portable-test.mjs <尚不存在的输出目录>`。脚本构建完整程序与原生组件，包含原有美颜资源及其分发校验，不修改标准发布配置。

验证：`node scripts/verify-portable-test.mjs <安装后的EXE> <证据目录>`。已使用 NSIS 安装到独立目录，在保持发布安全开关的程序上验证空白配置、损坏授权及重启均进入工作区；实际主进程输出权限、工程创建、原生设备枚举和日志读取通过。安装后的 app.asar 与打包目录一致，SHA256 为 `C6543258764A0EDDDAE5FA32C02A254077D7EA9E56EB9C2E1A638594E0C636C2`。

类型检查、相关授权回归和修改文件 lint 已通过。原始证据位于输出目录 `installed-acceptance/acceptance.json`，启动截图在各自子目录；工作区日志为 `artifacts/portable-test-*-20261006.log`。

不同主机标识通过授权逻辑回归，实际安装验收在当前 Windows 主机完成，未声称另一台实体主机已测。此包不代表六小时声光画面验收完成，已知稳定性和 MA2 实机兼容性缺口继续保留。
