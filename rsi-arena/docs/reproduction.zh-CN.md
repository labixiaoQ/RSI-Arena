# 从公开仓库复现

本页面向 [labixiaoQ/RSI-Arena](https://github.com/labixiaoQ/RSI-Arena) 的完整源码快照。仓库已包含修改后的 `gear/`、AAArena 源码与游戏资源包，以及网站和 runner；**直接克隆后不要再次给 `gear/` 应用升级补丁，也不要在已有 `aaarena/` 上重复 clone。**

以下默认使用 macOS 或 Linux/WSL 的 shell，Node.js 24+（Gear 也支持 22.19+）、npm、Python 3.10+、Git。安装依赖需要网络；下述受控验证不需要 DeepSeek 密钥、Docker、云端账号或付费额度。Python 用于资源校验，以及部分 Gear 原生测试所需的 Python worker；仅安装基础包，不安装训练或模型服务。

## 1. 获取源码与固定资源

```sh
git clone https://github.com/labixiaoQ/RSI-Arena.git
cd RSI-Arena
git rev-parse HEAD
python3 aaarena/scripts/install_assets.py --games monecraft
python3 aaarena/scripts/install_assets.py --games monecraft --verify-only
```

记录输出的提交号，以便复现同一版本。安装器只从仓库内 `aaarena/assets/monecraft.tar.gz` 解压并验证 227 个文件，不启动游戏，也不下载额外游戏数据。解压目录 `aaarena/games/` 被 Git 忽略。

## 2. 构建 Gear 并运行受控测试

从仓库根目录执行：

```sh
cd gear
npm ci
python3 -m venv .venv
.venv/bin/pip install -e ./python
export GEAR_PYTHON="$PWD/.venv/bin/python"
npm run build
npm test -- tests/unit/arena.spec.ts tests/unit/arena-learning.spec.ts tests/unit/arena-continuation.spec.ts tests/unit/arena-model.spec.ts tests/unit/arena-v3.spec.ts
cd ..
```

Gear 测试配置还会在测试前构建一次运行时。构建会获取并校验固定版本的 ToolFs npm 包；不能把首次构建称为完全离线。上述五组测试验证 I 继承、一步后续评测、预算、恢复和模型输出失败语义；本地 HTTP 模拟与 fixture 不会访问真实模型。

## 3. 验证网站与 runner

```sh
cd rsi-arena
npm ci
npm test
npm run typecheck
node platform-runner/cli.mjs --preflight
node platform-runner/cli.mjs --plan
npm run build
cd ..
```

`npm test` 覆盖后端、runner 和 Windows 代理传输测试，依赖上一步的 Gear 构建和游戏资源。`--preflight` / `--plan` 只读取源码、资源与构建，输出协议、实现摘要和预算；不会领取线上任务、调用模型或启动 Docker。输出的镜像摘要是**配置要求**，不代表本机已安装、可运行或重新构建出该镜像。

如配置了 `ARENA_GEAR_ROOT`、`ARENA_GAME_ROOT` 或 `ARENA_GEAR_BUILD`，它们会覆盖默认相邻目录；首次复现请避免继承其他项目的配置。测试不需要 `ARENA_ENABLE_LIVE=1`。

## 4. 本地打开网站（可选）

完成上述构建后，从 `rsi-arena/` 执行一次两份数据库迁移：

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_warm_ender_wiggin.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_slow_sir_ram.sql
npm run dev
```

打开 `http://localhost:5173`。迁移针对本地 D1；已迁移的数据库无需重跑。克隆中没有 `.sites-runtime/`，默认使用 portable 本地配置。历史公开结果和 42 局回放已包含在 `public/data/` 中，查看它们无需重跑模型。

要测试本地提交、审批和 runner 回传，在忽略的 `rsi-arena/.dev.vars` 中配置 `ARENA_ADMIN_EMAIL=seedy@sites.test` 与一个自行生成的 `ARENA_RUNNER_TOKEN`。在另一个忽略的 `.env.runner` 文件中放入同一 runner token，并设置 `ARENA_ENABLE_LIVE=0`。保存 `.dev.vars` 后重启 `npm run dev`。开发登录是本地 mock 身份，仅用于本机验证；不能作为生产认证。

保持本地服务运行，在第二个终端从 `rsi-arena/` 执行：

```sh
node --env-file=.env.runner tests/service-e2e.mjs
```

该脚本只连接 `127.0.0.1:5173`，创建私有受控任务，运行真实 Gear 编排但使用模拟模型和模拟比赛，验证审批、I 继承、上传及预算。它会更新本地数据库、`work/service-e2e/` 和 `docs/validation/service-e2e.json`；最后一个文件是新的本地验证记录，不要冒充仓库原有历史证据。

## 真实游戏与线上部署的边界

以上步骤复现的是工程闭环，不会重新生成历史 DeepSeek 得分。历史 v2 试验的公开回放和摘要已收录；原始模型请求、私有账本、凭证和 `gear/arena-runs/` 不在公开仓库，因而不承诺从本仓库完整重放原始模型调用或再次得到相同分数。v3 尚未完成新增真实模型的线上全链路验收。

真实 MoneCraft 执行另需 Docker/Linux。完整镜像的构建入口是仓库根目录下：

```sh
docker build --platform linux/amd64 -f gear/examples/arena/runtime/Dockerfile -t gear-arena-monecraft:local .
```

此命令仅作为另行准备真实游戏环境的入口，不属于上述无 Docker 验证；本轮未运行。不要使用依赖历史本机缓存镜像的 `Dockerfile.feedback`。基础镜像已固定，但系统软件安装不是位级可复现的快照，重建的内容摘要可能不同。

网站 `lib/platform-contract.ts` 与 runner `platform-runner/config.mjs` 当前固定历史运行配置，新的镜像不能直接替换该摘要。部署自己的实例时，需核验并一致更新运行配置、重新预检、审批新任务；不能修改旧 manifest 或声称本机拥有历史镜像。当前容器是人工审核下的实验环境，并非匿名恶意代码的生产隔离方案。

本地开发不需要 Sites 账号。部署线上则需要自己的 Sites 项目、D1/R2、可信登录和环境变量：`.openai/hosting.json` 中的项目 ID 仅标识本项目部署，不授予访问权；不要把自己部署的版本发布到原站点。模型密钥只配置在独立 runner。完整操作见 [runner 文档](runner.zh-CN.md) 和 [架构说明](architecture.zh-CN.md)。任何新付费试验仍需单独批准，本页不授权调用模型。

## 固定来源与可选升级包

- Gear 基线：`11bad082e1163d12caf2f955125d596f40b395f1`，来源 [rsi-gear/gear](https://github.com/rsi-gear/gear)。
- AAArena 基线：`fd52d2337b6711f0f3a239216f48720c125750be`，来源 [THU-CST-SAST/AAArena](https://github.com/THU-CST-SAST/AAArena)。
- MoneCraft 包 SHA-256：`69fffd4d77f7da743e22a4251ef9920cd0f082ef110647a0db815a44657a287a`。
- [来源快照](../../SOURCE_PROVENANCE.json) 与 [第三方声明](../../THIRD_PARTY_NOTICES.md) 保留上游版本与许可证。

仅当你要从独立、干净的上游 Gear 构建时，使用 [Gear Arena v3 升级包](../public/downloads/gear-arena-v3.tar.gz)。在仓库外的新空目录解压后：

```sh
tar -xzf gear-arena-v3.tar.gz
node gear-arena-v3/verify.mjs
git clone https://github.com/rsi-gear/gear.git gear
git -C gear checkout --detach 11bad082e1163d12caf2f955125d596f40b395f1
node gear-arena-v3/apply.mjs ./gear
```

升级包只交付 Gear 部分，不含网站、私有试验目录或游戏数据；`verify.mjs` 校验载荷，`apply.mjs` 拒绝错误基线、脏目录和重复覆盖。包中历史文档保留当时状态，不覆盖本仓库的最新验收记录。
