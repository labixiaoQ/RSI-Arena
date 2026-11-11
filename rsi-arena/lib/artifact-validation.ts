import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const short = z.string().min(1).max(200);
const note = z.string().max(2000);
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const points = z.number().min(0).max(1);
const armId = z.enum(["B", "C"]);
const counts = z
  .object({
    modelRequests: natural,
    tokens: natural,
    matches: natural,
    episodes: natural,
  })
  .strict();
const position = { x: natural.max(30), y: natural.max(30) };
const player = z.object({ id: natural.max(1), ...position }).strict();
const mine = z
  .object({ id: natural.max(5), owner: z.number().int().min(-1).max(1) })
  .strict();
const auditScore = z
  .object({
    seed: natural,
    score: points,
    status: z.enum(["completed", "task_failed"]).optional(),
    failureReason: z
      .enum(["malformed_json", "invalid_harness", "truncated"])
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "task_failed") {
      if (value.score !== 0 || !value.failureReason)
        issue(ctx, "lookahead 任务失败须有原因并计 0 分");
    } else if (value.failureReason != null)
      issue(ctx, "正常审计不得带任务失败原因");
  });
const match = z
  .object({
    id,
    experimentId: id,
    arm: armId,
    phase: z.enum(["training", "development", "audit"]),
    seed: natural,
    seat: natural.max(1),
    score: points,
    opponent: short,
    rounds: natural.max(1000),
    status: z.enum(["complete", "policy_failed"]).optional(),
    replayUrl: z
      .string()
      .regex(/^\/replays\/[a-zA-Z0-9_-]{1,100}$/)
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "policy_failed") {
      if (value.score !== 0 || value.rounds !== 0 || value.replayUrl !== null)
        issue(ctx, "失败策略必须计 0 分、0 回合且没有回放");
    } else if (
      value.replayUrl !== `/replays/${value.id}` ||
      ![0, 0.5, 1].includes(value.score)
    ) {
      issue(ctx, "完整对局必须使用自身回放和合法对局积分");
    }
  });

function issue(ctx: z.RefinementCtx, message: string) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}
function unique(
  values: Array<string | number>,
  ctx: z.RefinementCtx,
  name: string,
) {
  if (new Set(values).size !== values.length) issue(ctx, `${name} 不得重复`);
}
function pairedPlayers(values: Array<{ id: number }>, ctx: z.RefinementCtx) {
  if (!values.some((p) => p.id === 0) || !values.some((p) => p.id === 1))
    issue(ctx, "玩家必须恰好包含座位 0 和 1");
}

export const experimentSchema = z
  .object({
    id,
    title: short,
    summary: note,
    game: z.literal("MoneCraft"),
    status: z.literal("completed"),
    evidence: z.enum(["live", "controlled"]),
    protocolId: z.literal("arena-v3"),
    model: z.enum(["deepseek-flash", "controlled-fixture"]),
    createdAt: z.string().datetime(),
    classification: z.enum([
      "same_harness_repeat",
      "exploratory",
      "controlled_validation",
    ]),
    sameHarness: z.boolean(),
    amendment: note.nullable(),
    metricScope: short,
    usage: counts,
    limits: counts,
    arms: z
      .array(
        z
          .object({
            id: armId,
            label: short,
            mode: z.enum(["fixed-improver", "recursive"]),
            score: points,
            gate: short,
            retainedHarness: sha,
            initialImprover: sha,
            finalImprover: sha,
            scores: z.array(auditScore).min(2).max(20),
          })
          .strict(),
      )
      .length(2),
    nodes: z
      .array(
        z
          .object({
            id,
            label: short,
            arm: armId,
            epoch: natural,
            state: z.enum([
              "initial",
              "accepted",
              "rejected",
              "invalid",
              "retained",
            ]),
            executor: sha,
            improver: sha,
            note,
          })
          .strict(),
      )
      .min(4)
      .max(100),
    edges: z
      .array(z.object({ from: id, to: id }).strict())
      .min(2)
      .max(150),
    matches: z.array(match).max(72),
    notes: z.array(note).max(20),
    artifacts: z
      .array(
        z
          .object({
            title: short,
            url: z.string().regex(/^\/api\/artifacts\/[a-f0-9]{64}$/),
            digest: sha.optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.arms.length !== 2) return;
    unique(
      value.arms.map((arm) => arm.id),
      ctx,
      "实验臂",
    );
    unique(
      value.nodes.map((node) => node.id),
      ctx,
      "谱系节点",
    );
    unique(
      value.edges.map((edge) => `${edge.from}/${edge.to}`),
      ctx,
      "谱系边",
    );
    unique(
      value.matches.map((game) => game.id),
      ctx,
      "比赛",
    );
    unique(
      value.artifacts.map((artifact) => artifact.url),
      ctx,
      "产物引用",
    );
    for (const key of [
      "modelRequests",
      "tokens",
      "matches",
      "episodes",
    ] as const)
      if (value.usage[key] > value.limits[key])
        issue(ctx, "消耗不能超过批准额度");
    if (value.evidence === "controlled") {
      if (
        value.model !== "controlled-fixture" ||
        value.classification !== "controlled_validation" ||
        value.usage.modelRequests !== 0 ||
        value.usage.tokens !== 0 ||
        value.matches.length !== 0
      )
        issue(ctx, "受控验证不得冒充真实模型调用或游戏回放");
    } else if (
      value.model !== "deepseek-flash" ||
      value.classification !==
        (value.sameHarness ? "same_harness_repeat" : "exploratory")
    ) {
      issue(ctx, "真实试验证据类型或同 H 分类不一致");
    }
    const [first, second] = value.arms;
    if (
      value.sameHarness !==
      (first.retainedHarness === second.retainedHarness)
    )
      issue(ctx, "同 H 标记必须与冻结产物一致");
    if (first.initialImprover !== second.initialImprover)
      issue(ctx, "两臂须从相同 I 开始");
    if (
      first.scores
        .map((entry) => entry.seed)
        .sort((a, b) => a - b)
        .join() !==
      second.scores
        .map((entry) => entry.seed)
        .sort((a, b) => a - b)
        .join()
    )
      issue(ctx, "两臂须使用相同审计种子");
    for (const arm of value.arms) {
      if (arm.mode !== (arm.id === "B" ? "fixed-improver" : "recursive"))
        issue(ctx, "实验臂模式不一致");
      if (arm.id === "B" && arm.initialImprover !== arm.finalImprover)
        issue(ctx, "固定 I 臂不能改变 I");
      unique(
        arm.scores.map((entry) => entry.seed),
        ctx,
        "审计种子",
      );
      const mean =
        arm.scores.reduce((sum, entry) => sum + entry.score, 0) /
        arm.scores.length;
      if (Math.abs(mean - arm.score) > 1e-9)
        issue(ctx, "总分必须包含全部审计 episode");
      const nodes = value.nodes.filter((node) => node.arm === arm.id);
      const roots = nodes.filter((node) => node.state === "initial");
      if (
        roots.length !== 1 ||
        roots[0].epoch !== 0 ||
        roots[0].improver !== arm.initialImprover
      )
        issue(ctx, "初始谱系节点与实验臂不一致");
      const lastEpoch = Math.max(...nodes.map((node) => node.epoch));
      if (
        !nodes.some(
          (node) =>
            node.epoch === lastEpoch &&
            node.state === "retained" &&
            node.improver === arm.finalImprover,
        )
      )
        issue(ctx, "最终保留 I 缺少对应谱系节点");
    }
    const roots = value.nodes.filter((node) => node.state === "initial");
    if (
      roots.length === 2 &&
      (roots[0].executor !== roots[1].executor ||
        roots[0].improver !== roots[1].improver)
    )
      issue(ctx, "两臂必须从相同 H 开始");
    for (const edge of value.edges) {
      const from = value.nodes.find((node) => node.id === edge.from),
        to = value.nodes.find((node) => node.id === edge.to);
      if (!from || !to || from.arm !== to.arm || from.epoch >= to.epoch)
        issue(ctx, "谱系边必须连接同臂的前后代");
    }
    for (const node of value.nodes)
      if (
        node.state !== "initial" &&
        !value.edges.some((edge) => edge.to === node.id)
      )
        issue(ctx, "谱系节点缺少来源");
    for (const game of value.matches)
      if (game.experimentId !== value.id) issue(ctx, "比赛不属于当前实验");
    for (const artifact of value.artifacts)
      if (
        artifact.digest &&
        artifact.digest !== `sha256:${artifact.url.split("/").pop()}`
      )
        issue(ctx, "产物链接与摘要不一致");
  });

export const replaySchema = z
  .object({
    id,
    experimentId: id,
    title: short,
    board: z.array(z.array(natural.max(1)).length(31)).length(31),
    initialPlayers: z.array(player).length(2),
    initialMines: z.array(mine.extend(position)).length(6),
    frames: z
      .array(
        z
          .object({
            round: natural.min(1).max(1000),
            players: z.array(player.extend({ blinkCd: natural })).length(2),
            mines: z
              .array(
                mine.extend({
                  point: z.number().int().min(-5).max(5),
                  protection: natural,
                }),
              )
              .length(6),
            gold: z.array(natural).length(2),
            mineCounts: z.array(natural.max(6)).length(2),
            observers: z
              .array(
                z
                  .object({ id: natural, owner: natural.max(1), ...position })
                  .strict(),
              )
              .max(200),
          })
          .strict(),
      )
      .max(1000),
    winner: z.number().int().min(-1).max(1),
    seed: natural,
    seat: natural.max(1),
    rounds: natural.max(1000),
    sourceDigest: sha,
  })
  .strict()
  .superRefine((value, ctx) => {
    pairedPlayers(value.initialPlayers, ctx);
    unique(
      value.initialMines.map((entry) => entry.id),
      ctx,
      "矿点",
    );
    if (value.rounds !== value.frames.length)
      issue(ctx, "回合数与回放帧数不一致");
    const passable = (p: { x: number; y: number }) =>
      value.board[p.y]?.[p.x] === 0;
    if (
      [...value.initialPlayers, ...value.initialMines].some(
        (entry) => !passable(entry),
      )
    )
      issue(ctx, "初始单位必须位于可通行地形");
    for (const [index, frame] of value.frames.entries()) {
      if (frame.round !== index + 1) issue(ctx, "回放帧必须从 1 开始连续");
      pairedPlayers(frame.players, ctx);
      unique(
        frame.mines.map((entry) => entry.id),
        ctx,
        "每帧矿点",
      );
      unique(
        frame.observers.map((entry) => entry.id),
        ctx,
        "每帧观察器",
      );
      if (
        [...frame.players, ...frame.observers].some((entry) => !passable(entry))
      )
        issue(ctx, "单位必须位于可通行地形");
      for (const owner of [0, 1])
        if (
          frame.mineCounts[owner] !==
          frame.mines.filter((entry) => entry.owner === owner).length
        )
          issue(ctx, "矿点计数与所有权不一致");
    }
  });

// Inspect original strings, not JSON-escaped text. Only the trusted publisher may choose
// public fields; this defensive filter does not make arbitrary model output publishable.
function assertPublicStrings(value: unknown): void {
  if (typeof value === "string") {
    const privatePath =
      /(?:\/(?:Users|home|private|tmp|var|etc|root|mnt|Volumes|workspace|workspaces|srv|proc|dev|opt)\/|(?:^|[\s"'(=])[A-Z]:[\\/]|file:\/\/|\\\\[a-z0-9])/i;
    const credential =
      /(?:\bsk-(?:proj-|ant-)?[a-z0-9_-]{12,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[a-z0-9]{20,}|\bgithub_pat_[a-z0-9_]{20,}|\bBearer\s+[a-z0-9._~+/=-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|DEEPSEEK_API_KEY)\s*[=:]\s*\S+)/i;
    if (privatePath.test(value) || credential.test(value))
      throw new Error("产物包含禁止公开的路径或凭证格式");
  } else if (Array.isArray(value)) {
    for (const entry of value) assertPublicStrings(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) assertPublicStrings(entry);
  }
}

export function validateArtifact(raw: unknown) {
  const envelope = z
    .object({ kind: z.enum(["experiment", "replay"]), data: z.unknown() })
    .strict()
    .parse(raw);
  const data =
    envelope.kind === "experiment"
      ? experimentSchema.parse(envelope.data)
      : replaySchema.parse(envelope.data);
  assertPublicStrings(data);
  return { kind: envelope.kind, data };
}
