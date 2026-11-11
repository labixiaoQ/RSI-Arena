# 可信执行器运行说明

网站负责登录、人工批准、任务租约和公开结果；本执行器在专用机器上调用 Gear 和 MoneCraft。默认关闭真实模型执行。匿名访客和普通提交不会自动消耗站方额度，旧试验批准不用于新任务。

## 准备与检查

需要 Node.js 22.19+ 或 24+，同一受控工作区内的 Gear 构建及 MoneCraft 资源。仓库默认布局是 `gear/`、`aaarena/games/monecraft/`、`rsi-arena/`。在 Gear 中完成依赖安装和构建后，从网站目录运行：

```sh
node platform-runner/cli.mjs --preflight
node platform-runner/cli.mjs --plan
node --test platform-runner/tests/runner.test.mjs
```

两种检查命令都只读取固定资源和本机构建，输出协议摘要、Gear 实现摘要、镜像摘要和预算；不会联系模型，不启动 Docker，也不启动虚拟机。模型凭证只报告是否存在，不输出正文。代码或资源变化后，需要重新检查摘要并更新网站允许的 profile；已有批准不可修改。

## 配置

在专用运行环境配置下列变量，凭证通过环境或本机秘密管理注入，不写入仓库：

| 变量 | 用途 |
| --- | --- |
| `ARENA_SITE_URL` | 已部署网站 HTTPS 地址；本地验证允许 localhost HTTP |
| `ARENA_RUNNER_TOKEN` | 仅 runner API 使用的独立令牌，需与网站一致 |
| `ARENA_JOB_ID` | 可选：仅领取此任务；不存在或未批准时保持空闲，执行前再次核对，不替换成其他排队任务 |
| `ARENA_WORKER_ID` | 机器标识，默认 `trusted-local-runner` |
| `ARENA_RUNNER_ROOT` | 持久任务目录，默认 `rsi-arena/work/runner` |
| `ARENA_GEAR_ROOT` | Gear 本机源码及资源根目录 |
| `ARENA_GEAR_BUILD` | 可选，已构建 Gear 的 `lib` 目录 |
| `ARENA_GAME_ROOT` | MoneCraft 本机资源根目录 |
| `ARENA_ENABLE_LIVE` | 只有明确设置为 `1` 才允许真实执行 |
| `DEEPSEEK_API_KEY` | 真实执行用本机模型凭证，永不上传给网站或游戏容器 |
| `ARENA_DOCKER_CONTEXT` | 专用 Linux Docker context，默认 `default` |
| `ARENA_APPARMOR_PROFILE` | 本机预装限制 profile，默认 `gear-arena-bwrap` |

模型地址固定为 DeepSeek 官方接口，模型固定为 `deepseek-flash`。镜像固定为合同中的内容摘要。任务提交不能更改地址、凭证变量、镜像、命令、路径或裁判。不要给模型或游戏容器挂载工作区、云端令牌文件或 Docker socket。

## 运行

```sh
node platform-runner/cli.mjs --once
node platform-runner/cli.mjs --poll
```

`--once` 最多领取一个已批准任务；`--poll` 逐个轮询，Ctrl+C 或 SIGTERM 会停止轮询并中止当前操作。两者都不会启动 VM。网站的运营端批准必须绑定具体任务、不可变 manifest 摘要和完整五维额度。默认仅运行运营端创建的 controlled 任务；生产模型还需本地开关和凭证。

一个任务使用独立持久目录。Gear 真正负责 B/C 搜索、I 继承、一步后续评测、完整代预算、模型实耗和未知消耗；执行器直接调用 Gear API，不调用历史试验 CLI。受控模式使用同一 Gear 流程，但模型和对局由确定性 fixture 提供。其 API 请求和 token 实耗为零，模拟分数只验证路径，不代表模型提升，也不生成假游戏回放。

真实执行仍属于 experimental development profile：当前容器包含已有 `seccomp=unconfined` 和 `systempaths=unconfined` 设置，尚未构成面向任意恶意代码的生产隔离保证。仅使用人工审核的任务及专用、可销毁 Linux 主机；不要与日常工作机器或其他业务服务共置。

## 中断与恢复

心跳每 20 秒更新；租约独立计时。心跳失败立即中止活动调用，租约到期也会触发中止，每次模型或游戏动作前再次检查。云端不会自动接管已启动任务，本地不会自动复用已有任务目录。

出现不明模型消耗、失联或已有目录时保留全部账本及预留额度，显示 `needs_recovery`。禁止删除目录后重新领取、换目录重跑或把未知用量填成零。取消请求只有在执行停止且消耗确认后才可成为 `cancelled`。

私有目录包括：

- `runner-checkpoint.json`：首次领取的任务与租约身份；只创建一次。
- `approved-job.json`：本次明确批准的完整任务。
- `gear/`：Gear 原生 journal、导出 H、回执及四个预算账本。
- `games/`、`recordings/`：真实执行的本机对局材料。
- `execution-profile.json`：实际代码、模型、镜像身份与预算计划。
- `publication.json`：上传成功后、最终完成请求前写入的产物摘要和精确回执。
- `runner-state.json`：最近可确认的本机状态。

`runner.owner` 防止两个进程同时使用同一根目录。崩溃后它可能保留，执行器会停止而不会自动解锁。运营人员必须先确认原进程、模型操作和容器状态，保留证据，再决定如何恢复。首版没有盲目自动恢复命令。

只有允许的 Experiment/Replay DTO 上传到网站；原始模型请求、本机路径、秘密和任意工作区文件不会上传。内容地址使用上传 JSON 原始字节摘要，网站再次验证类型、归属、摘要和额度；所有必需产物就绪后才完成任务。

## 只检查连接

运行 `node platform-runner/cli.mjs --check-connection` 会校验服务认证、线上 D1 与 R2 读取通道；不会领取任务、创建租约、调用模型或启动比赛。必须在实际执行机器上通过此检查，再启用轮询。如果收到平台边缘的 HTML 403，说明请求尚未到达应用；不能当作任务失败或重置预算，应先解决该机器的正常访问通道。

## WSL 使用已配置的 Windows 网络代理

当 Windows 已启用 `127.0.0.1:端口` 系统代理、WSL NAT 没有继承该代理时，可设置 `ARENA_HTTP_TRANSPORT=windows-proxy`。runner 通过 Windows 自带 HttpClient 和现有代理访问本站；不会修改全局代理、开放监听端口、关闭证书校验或改变任务审批。请求与认证信息只经子进程 stdin 传入，不放进命令行。此选项只影响网站管理接口；模型与游戏执行仍遵守既有固定配置。

先运行 `--check-connection`。传输超时意味着请求结果可能未知，不能据此重新启动实验；领取和完成沿用原有幂等及账本规则。默认 `native` 适合正常可达的 Linux 主机。

## 运营台的零模型费用验收

站点所有者在 `/ops` 点击“创建零模型费用验收任务”，核对封存的指令后批准。该任务的模型请求与 token 额度均为 0；比赛/episode 计数来自模拟过程，不是真实游戏成本。任务仍经过正常登录、批准、领取、租约、Gear、上传和完成流程，结果默认私有。无需用真实模型额度检查网站链路。

WSL 当前部署与实际验收范围见 [部署记录](validation/wsl-deployment-2026-11-11.md)。Windows 代理模式为传输保留 20 秒超时，其余机器默认 10 秒；超时不会被记成零消耗。

一次性真实验收使用 `ARENA_JOB_ID` 配合 `--once`，只运行获准的那一个任务。指定任务尚未排队时返回 idle；幂等领取不能改成其他任务。服务端筛选与本机执行前校验同时生效，不能据此跳过逐任务批准、摘要或预算检查。

连续轮询模式在尚未开始任务的领取请求遭遇传输失败或 5xx 时，最多额外重试 3 次，每次保留原 `pending-claim.json` 中的 claim ID。401/403/409、领取过期、执行错误和心跳错误不进入此路径。重试耗尽则停止，保留记录；`--once` 不自动重试领取。
