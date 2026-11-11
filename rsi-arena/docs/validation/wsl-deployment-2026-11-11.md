# WSL 部署与验收

验证日期：2026-11-11。网站：https://rsi-arena-lab.chengrenmin76.chatgpt.site 。执行机使用用户既有 Ubuntu 24.04 / WSL；未更改全局 Node、代理、Docker context 或内核安全设置。

## 已验证

- 独立运行目录 `/home/cc/projects/rsi-arena-runner`，Node 24.22.2 使用官方 SHA256 校验。源码运行包 873 个文件逐项校验，Gear 的生产依赖按 lockfile 安装。
- Gear 实现摘要 `sha256:342f86065934819779d6f82295d661b14baec6520082f5b6f4996174c8fc7e43`、协议摘要 `sha256:1fb80c81895de8b523ba65bbf196a3e9b24d8340d38456e1d2297b8c3ed96cb6` 与网站批准配置一致。
- amd64 游戏镜像以 `docker save/load` 原样迁移，镜像摘要仍为 `sha256:363c67d8186b9a13cb4898f191389ade38d2d534f74dca7e2632659a341cf6f7`。导出压缩包 SHA256 为 `e62e64b5afbc002a3a69f56473c13998eb66056f9563f6ccaec62d2121b51d52`。
- WSL 完成固定 stop 策略的真实编译和一局 1000 回合对战：seed 31、seat 0、对手为固定公开策略，正常终局、score 0。这是运行环境验收，不计作新的 RSI 能力试验。
- 网站 runner 健康接口通过：认证、D1、R2 可访问。Windows 已有的 loopback 系统代理通过 stdin 适配使用；TLS 校验保持开启，不开放新的端口。
- 完成后没有遗留 `gear-arena-*` 游戏容器；Mac 上为导出镜像临时启动的 Colima 已停止，默认 Docker context 保持 `default`。
- 本轮没有传输 DeepSeek 密钥，新增模型请求和 token 均为 0；只新增上述 1 局工程验收对局。此前试验账本不变。

## 环境差异与边界

该 WSL 内核返回 AppArmor=N，因此为它显式配置 `ARENA_APPARMOR_PROFILE=unconfined`；没有关闭任何原本启用的主机策略。此环境及现有容器 profile 不提供恶意代码的生产级隔离。当前机器与其他研究项目共存，服务只开放确定性受控任务；真实模型功能保持关闭。要开放真实参评，需在适合此实验隔离级别的执行环境完成凭证及逐任务授权，不能沿用旧试验的剩余额度。

Arena 的 TypeScript 运行入口和游戏镜像已经包含本阶段所需运行时。主机 Python 可选依赖安装曾因下载超时未完成，Arena 路径不依赖该 venv，未将它配置到运行服务；不宣称通用 Gear Python 训练/算法功能在该机验收完成。

## 服务

用户级服务 `rsi-arena-runner.service`，配置文件 `runner.env` 权限 0600，`ARENA_ENABLE_LIVE=0`。默认用户会话启动服务，WSL 与 Windows 现有代理必须运行。服务使用 `/run/WSL/1_interop`，已在该机验证。主机重启、休眠或退出用户会话可能使服务离线；此部署不承诺全天在线。

服务失败不自动重启。检查日志和本地账本后人工恢复；存在 `pending-claim.json` 时保留原 claim ID，同一领取响应可幂等恢复，不能删掉文件后制造新领取。已开始的任务未知消耗继续预留。

## 验收边界

35 项平台/执行器测试已通过；本地真实 HTTP + D1/R2 + Gear fixture 的完整流程已通过，报告见 `service-e2e.json`，包括 C 继承 I、B 保持 I、产物上传和私有访问控制。真实模型结果与 42 份对局回放来自已完成的历史试验。

所有者正常登录后，线上“提交—批准—WSL—产物回传”已完成：任务 `run-7d53ba32-6b18-4530-8d7c-9474ebf16681` 于 16:53（北京时间）完成。云端与 WSL 的摘要、账本一致；B 保持初始 I，C 接纳并导出新 I；模型请求、token、真实对局均为 0，模拟对局 60、episode 10。所有者可查看结果，匿名读取实验与产物均返回 404，没有遗留游戏容器。详见 [线上验收证据](production-controlled-e2e-2026-11-11.json)。

真实模型的线上全链路尚未运行，后续需新增具体额度授权。为一次性验收新增精确任务筛选，最终平台/runner 回归 39 项通过、类型检查通过；Gear 协议与实现摘要没有改变。

线上任务完成后的空闲领取曾因一次网络超时退出，任务已完成且账本没有不明消耗。后续版本为尚未开始任务的幂等领取添加最多 3 次原 ID 重试，并测试 409 不重试、5xx 重试耗尽保留 ID；实际模型、比赛与心跳的失败行为不变。
