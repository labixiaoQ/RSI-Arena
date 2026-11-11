# RSI Arena

以 MoneCraft 对战为环境，评测 Agent 的递归自我改进。首版包含公开实验、完整回放、E/I 谱系、预算账本、登录提交、逐任务审批和独立执行器。

网站评估的是“改进方法能否帮助后续学习”。正收益不是验收前提；固定模型、失败处理、跨代继承和完整成本记录是前提。

## 当前证据

- 历史真实 DeepSeek B/C 试验：23 次模型请求，79,462 token，42 局真实对战，1000 回合/局。
- B/C 审计均分 0.375 / 0.500，但最终 H 完全相同。差异不能归因于 I 或递归 RSI。
- C 提案超出 2048 字节，经已确认回执本地重建，新增模型请求和对局均为 0；历史原始产物保持不变。
- v3 修复已确认无效 lookahead 的失败结算；公开种子探索性协议，尚无正式隐藏排名。
- 网站到 Gear 的受控端到端验证使用真实编排、数据库和上传链路，模型与游戏为 fixture。受控分数不是能力结果。

## 架构与边界

```text
浏览器 → Sites / Cloudflare Worker → D1（提交、批准、租约、账本快照）
                    └──────────→ R2（按摘要保存公开结果和回放）
                         ↑ HTTPS 出站轮询
                     独立 trusted runner
                         ├─ Gear：E/I 继承、一步后续评测、本地 SQLite 预留账本
                         ├─ 固定模型配置：DeepSeek，凭证只在 runner
                         └─ MoneCraft Docker：固定 SDK、裁判、镜像与对手
```

网站不运行 Docker，也不持有模型密钥。用户只能提交 E/I 指令；模型、接口、镜像、路径和额度由固定服务配置控制。每次审批绑定不可变 manifest 摘要，旧试验授权不会复用。

当前执行环境为 development-container-v1：人工审核后由专用执行机器运行。网站不提供匿名即时执行。runner 未在线时任务留队；已经执行的任务租约失效会进入 needs_recovery，不自动接管或重复付费。首版不宣称全天候计算服务或生产恶意代码隔离。

## 开发

Node 22.13+。网站与已扩展 Gear 及 AAArena 保持同级：

```text
workspace/
  gear/
  aaarena/games/monecraft/
  rsi-arena/
```

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_warm_ender_wiggin.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_slow_sir_ram.sql
npm run dev
```

本地 `.dev.vars` 配置 `ARENA_ADMIN_EMAIL` 和 `ARENA_RUNNER_TOKEN`。本地登录模拟用户为 `seedy@sites.test`，仅本地预览使用；线上由 Sites 登录注入可信身份。线上密钥通过 Sites 环境变量管理，禁止提交版本库。

## 验收

```sh
npx tsc --noEmit
node --experimental-vm-modules --test tests/backend-review.test.mjs platform-runner/tests/runner.test.mjs
node --env-file=.env.runner tests/service-e2e.mjs
```

最后一项需要本机 5173 预览与已初始化 D1/R2；它只创建私有受控验证任务，不请求真实模型或真实比赛。验证报告写入 `docs/validation/`。

`python3 scripts/import-history.py` 从原始已完成试验重新导出 42 局白名单回放和证据摘要，验证地图坐标，排除模型输入、日志、密钥和宿主路径。

## 运营

1. 访客浏览真实结果，登录后提交 E/I，每项最多 2048 UTF-8 字节。
2. 所有者在 `/ops` 查看完整指令、manifest 摘要和保守上限，写明本次授权后批准；批准并非立即执行。
3. 独立 runner 领取与自身能力相符的任务。默认只允许 controlled-fixture；付费任务还需本机显式开启 live。
4. 用户可取消待处理请求。运行中取消需等待实际停止确认；未确认消耗保留。
5. 结果经预算、身份、回放与摘要校验后公开。私有任务仅所有者和运营端可读。

完整启动、恢复及执行隔离说明见 [runner 文档](docs/runner.zh-CN.md)；接口见 [HTTP contract](platform-runner/contract.md)。

## 复现基础

- Gear 上游：`rsi-gear/gear`，基线 `11bad082e1163d12caf2f955125d596f40b395f1`。
- AAArena 游戏仓库基线：`fd52d2337b6711f0f3a239216f48720c125750be`。
- 本项目扩展 Gear Arena v3；安装后的协议与实现摘要由 `node platform-runner/cli.mjs --preflight` 校验，不能随意替换为未经批准的构建。
- 保留全部原始真实试验于 Gear 本地 `arena-runs/`，网站仅发布经筛选的公开 DTO。
