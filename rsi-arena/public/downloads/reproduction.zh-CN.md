# Gear Arena 升级包与复现

下载 [Gear Arena v3 源码升级包](/downloads/gear-arena-v3.tar.gz)。它是固定 Gear 基线上的完整补丁及新增文件覆盖层，包含协议、适配器、测试、运行示例、文档、每文件摘要和原 Gear LICENSE；不是另一个未经固定版本的 Gear fork。

当前网站已有的真实模型证据来自 **v2 探索性试验及明确标记的恢复修订**。两臂最终 H 相同，分差不证明 RSI 提升。**v3 的新增验证是受控 backend 与本地 mock HTTP，没有新增真实模型或游戏成绩。** 升级代码不能把 v2 历史结果改称 v3。

## 固定来源

- Gear：`https://github.com/rsi-gear/gear.git`，commit `11bad082e1163d12caf2f955125d596f40b395f1`。
- AAArena：`https://github.com/THU-CST-SAST/AAArena.git`，commit `fd52d2337b6711f0f3a239216f48720c125750be`。
- MoneCraft 资源由 AAArena 的 `assets/monecraft.tar.gz` 提供，归档 SHA-256 为 `69fffd4d77f7da743e22a4251ef9920cd0f082ef110647a0db815a44657a287a`。保留 AAArena/MoneCraft 的来源及许可文件。

来源地址来自当前本机仓库的 Git remote；本文不声称已重新联网验证可用性。升级包不重复分发游戏资源、依赖、模型凭证、原始模型请求/响应、工作区文件或历史运行目录。

## 在新副本应用

使用新建空目录，不在正在运行或含未提交修改的 Gear 中操作。以下以升级包和新克隆的 `gear/`、`aaarena/` 位于同一个父目录为例：

```sh
tar -xzf gear-arena-v3.tar.gz
node gear-arena-v3/verify.mjs
git clone https://github.com/rsi-gear/gear.git gear
git -C gear checkout --detach 11bad082e1163d12caf2f955125d596f40b395f1
node gear-arena-v3/apply.mjs ./gear
```

`verify.mjs` 核对 `manifest.json` 中每个载荷文件的字节摘要。`apply.mjs` 要求目标是干净的指定基线，先验证全部文件、`git apply --check` 和新增文件不冲突，再应用 `upgrade.patch` 与 `overlay/`，最后逐文件核对源码结果。它拒绝修改已有脏目录或再次覆盖已应用的副本。包中没有自动执行安装、模型调用或 Docker 的脚本。

安装与构建在上述新副本中完成：

```sh
cd gear
npm ci
python3 -m venv .venv
.venv/bin/pip install -e ./python
npm run build
npm run typecheck
GEAR_PYTHON="$PWD/.venv/bin/python" npm test -- tests/unit/arena.spec.ts tests/unit/arena-learning.spec.ts tests/unit/arena-continuation.spec.ts tests/unit/arena-model.spec.ts tests/unit/arena-v3.spec.ts
cd ..
```

Node.js 需要 22.19+ 或 24+。安装和 Gear 的标准构建可能访问依赖源，需要可用网络；本次打包没有执行这些下载。上述 Arena 单元测试使用受控模型/比赛及本地 HTTP 响应，不调用付费模型或真实游戏。仓库标准测试配置会先构建；受限离线环境应使用已核验的本地依赖与构建产物，不能将未跑测试写成通过。

## 获取固定游戏资源

```sh
git clone https://github.com/THU-CST-SAST/AAArena.git aaarena
git -C aaarena checkout --detach fd52d2337b6711f0f3a239216f48720c125750be
python3 aaarena/scripts/install_assets.py --games monecraft
python3 aaarena/scripts/install_assets.py --games monecraft --verify-only
```

AAArena 的安装脚本从仓库自带资源包解压并校验，不需要另找游戏源码或 Git LFS。当前完整 Dockerfile 引用相邻 `gear/` 与 `aaarena/`，从共同父目录构建；不要使用只针对历史本机缓存镜像的 `Dockerfile.feedback` 作为全新环境入口。

只有准备实际游戏执行时，才在专用 Linux 主机安装和构建 Docker 环境。当前容器属于 experimental development profile，不能当作匿名恶意代码的生产隔离保证。重建镜像的内容摘要可能不同于历史 Mac 开发镜像，不能把新镜像标成历史镜像或修改旧 manifest；需创建新的本机/网站 profile、重新预检并取得独立任务批准。

## 与网站 runner 配合

升级包交付 Gear 部分。网站源码包中的 `platform-runner/` 负责认证、任务领取、心跳、取消、上传和批准边界，见网站源码的 `docs/runner.zh-CN.md`。公共 v3 运行使用该新入口直接调用 `rsi-gear/arena`；包内 `run.mjs`、`compare.mjs` 和专用恢复示例保留历史 v1/v2 实验入口，不能把它们直接接到公开提交表单，也不能继承其历史额度记录。

先执行 runner 的 `--preflight`/`--plan` 核对实际协议、Gear 实现和镜像摘要，再批准新的具体任务。真实模型始终需要本地显式开关、凭证及与不可变 manifest 完全匹配的任务批准。默认受控验证没有真实模型消耗，公开页面必须保持 `controlled` 分类。

## 包内可核查内容

- `upgrade.patch`：基线上所有 tracked 修改，包括 package export、构建入口、类型注册和边界检查。
- `overlay/`：Arena 新增 `src/`、`tests/`、`examples/` 和 `docs/`。
- `manifest.json`：固定上游来源、每文件 SHA-256、tracked 应用后摘要、新增文件摘要与文档路径净化记录。
- `LICENSE`：原 Gear MIT 许可，原文保留。
- `verify.mjs` / `apply.mjs`：只验证和应用源码，不下载或启动实验。

历史验证文档只作为描述性来源保留。机器绝对路径已转换成相对来源引用，文档引用的历史 `arena-runs/` 产物不在源码包内；原始执行记录没有被改写。每个净化文件同时记录原始源码摘要与打包内容摘要，不能把净化后的文档摘要当成原始执行产物摘要。
