import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { z } from "zod";
import { validateArtifact } from "../lib/artifact-validation.ts";
import {
  CAPS,
  ZERO,
  counts,
  digest,
  hash,
  validateSnapshot,
} from "../lib/platform-contract.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (char = "a") => `sha256:${char.repeat(64)}`;
function experiment(id = "run-test", live = false) {
  return {
    id,
    title: "Protocol validation",
    summary: "Descriptive fixture only",
    game: "MoneCraft",
    status: "completed",
    evidence: live ? "live" : "controlled",
    protocolId: "arena-v3",
    model: live ? "deepseek-flash" : "controlled-fixture",
    createdAt: "2026-11-11T00:00:00.000Z",
    classification: live ? "same_harness_repeat" : "controlled_validation",
    sameHarness: true,
    amendment: null,
    metricScope: "Fixed seeds, descriptive episode score",
    usage: counts(ZERO),
    limits: counts(live ? CAPS : {...CAPS, model_requests: 0, tokens: 0}),
    arms: ["B", "C"].map((arm) => ({
      id: arm,
      label: arm,
      mode: arm === "B" ? "fixed-improver" : "recursive",
      score: 0.5,
      gate: "rejected",
      retainedHarness: sha(),
      initialImprover: sha("b"),
      finalImprover: sha("b"),
      scores: [
        { seed: 31, score: 0.5 },
        { seed: 47, score: 0.5 },
      ],
    })),
    nodes: ["B", "C"].flatMap((arm) =>
      [0, 1].map((epoch) => ({
        id: `${arm}-${epoch}`,
        arm,
        epoch,
        label: `${arm} ${epoch}`,
        state: epoch ? "retained" : "initial",
        executor: sha("c"),
        improver: sha("b"),
        note: "",
      })),
    ),
    edges: ["B", "C"].map((arm) => ({ from: `${arm}-0`, to: `${arm}-1` })),
    matches: [],
    notes: [],
    artifacts: [],
  };
}
function replay() {
  const initialPlayers = [0, 1].map((id) => ({ id, x: id, y: id }));
  const initialMines = Array.from({ length: 6 }, (_, id) => ({
    id,
    x: id + 2,
    y: 0,
    owner: -1,
  }));
  return {
    id: "match-test",
    experimentId: "run-test",
    title: "Replay",
    board: Array.from({ length: 31 }, () => Array(31).fill(0)),
    initialPlayers,
    initialMines,
    frames: [
      {
        round: 1,
        players: initialPlayers.map((p) => ({ ...p, blinkCd: 0 })),
        mines: initialMines.map(({ id, owner }) => ({
          id,
          owner,
          point: 0,
          protection: 0,
        })),
        gold: [0, 0],
        mineCounts: [0, 0],
        observers: [],
      },
    ],
    winner: -1,
    seed: 31,
    seat: 0,
    rounds: 1,
    sourceDigest: sha("d"),
  };
}
function match(id = "match-test") {
  return {
    id,
    experimentId: "run-test",
    arm: "B",
    phase: "audit",
    seed: 31,
    seat: 0,
    score: 0.5,
    opponent: "fixed-1",
    rounds: 1,
    replayUrl: `/replays/${id}`,
  };
}

test("strict artifacts accept coherent controlled, live and policy-failed results", () => {
  assert.equal(
    validateArtifact({ kind: "experiment", data: experiment() }).data.evidence,
    "controlled",
  );
  const live = experiment("run-test", true);
  live.matches = [
    match(),
    {
      ...match("failed-match"),
      status: "policy_failed",
      score: 0,
      rounds: 0,
      replayUrl: null,
    },
  ];
  live.usage.matches = 2;
  assert.equal(
    validateArtifact({ kind: "experiment", data: live }).data.matches.length,
    2,
  );
  assert.equal(
    validateArtifact({ kind: "replay", data: replay() }).data.frames.length,
    1,
  );
});

test("experiment validation rejects misclassification, biased means, unmatched seeds and forged lineage", () => {
  const mutations = [
    (e) => {
      e.arms[1].id = "B";
    },
    (e) => {
      e.arms[0].finalImprover = sha("e");
    },
    (e) => {
      e.arms[0].score = 1;
    },
    (e) => {
      e.arms[0].scores[1].seed = 31;
    },
    (e) => {
      e.arms[1].scores[1].seed = 59;
    },
    (e) => {
      e.sameHarness = false;
    },
    (e) => {
      e.classification = "exploratory";
    },
    (e) => {
      e.nodes[2].executor = sha("e");
    },
    (e) => {
      e.edges[0].to = "C-1";
    },
    (e) => {
      e.edges[0].to = "missing";
    },
    (e) => {
      e.nodes[1].improver = sha("e");
    },
    (e) => {
      e.nodes[1].id = e.nodes[0].id;
    },
    (e) => {
      e.usage.tokens = Number.MAX_SAFE_INTEGER + 1;
    },
    (e) => {
      e.usage.matches = e.limits.matches + 1;
    },
    (e) => {
      e.matches = [match()];
    },
    (e) => {
      e.policy = "private source";
    },
    (e) => {
      e.arms[0].privatePrompt = "not public";
    },
  ];
  for (const mutate of mutations) {
    const data = experiment();
    mutate(data);
    assert.throws(
      () => validateArtifact({ kind: "experiment", data }),
      mutate.toString(),
    );
  }
});

test("live match summaries preserve failures and require their own replay identities", () => {
  for (const bad of [
    { ...match(), replayUrl: "/replays/other" },
    { ...match(), score: 0.2 },
    { ...match(), experimentId: "other-job" },
    { ...match(), replayUrl: null },
    { ...match(), status: "policy_failed", score: 0 },
  ]) {
    const data = experiment("run-test", true);
    data.matches = [bad];
    assert.throws(() => validateArtifact({ kind: "experiment", data }));
  }
});

test("audit task failures remain zero-scored observations with explicit causes", () => {
  const data = experiment();
  data.arms[0].scores[0] = {
    seed: 31,
    score: 0,
    status: "task_failed",
    failureReason: "invalid_harness",
  };
  data.arms[0].scores[1].status = "completed";
  data.arms[0].scores[1].failureReason = null;
  data.arms[0].score = 0.25;
  assert.equal(
    validateArtifact({ kind: "experiment", data }).data.arms[0].score,
    0.25,
  );
  data.arms[0].scores[0].score = 0.5;
  data.arms[0].score = 0.5;
  assert.throws(() => validateArtifact({ kind: "experiment", data }));
});

test("replay validation rejects extra fields, duplicate players, inconsistent frames and false mine counts", () => {
  for (const mutate of [
    (r) => {
      r.frames[0].players[0].privateFile = "/safe-looking";
    },
    (r) => {
      r.initialPlayers[1].id = 0;
    },
    (r) => {
      r.frames[0].players[1].id = 0;
    },
    (r) => {
      r.frames[0].mines[1].id = 0;
    },
    (r) => {
      r.frames[0].round = 2;
    },
    (r) => {
      r.rounds = 1000;
    },
    (r) => {
      r.frames[0].mineCounts[0] = 1;
    },
    (r) => {
      r.board[0][0] = 1;
    },
    (r) => {
      r.frames[0].players[0].x = 31;
    },
    (r) => {
      r.dataUrl = "https://elsewhere.invalid/file";
    },
  ]) {
    const data = replay();
    mutate(data);
    assert.throws(
      () => validateArtifact({ kind: "replay", data }),
      mutate.toString(),
    );
  }
});

test("public strings reject private paths and credential formats across nested fields", () => {
  for (const value of [
    "/Users/person/key",
    "/private/var/run/receipt",
    "/tmp/job/key",
    "/home/person/run",
    "C:\\Users\\person\\key",
    "file:///somewhere/file",
    "\\\\server\\share",
    "sk-test-abcdefghijklmnop",
    "Bearer abcdefghijklmnop",
    "DEEPSEEK_API_KEY=placeholder",
    "client_secret: value",
    "-----BEGIN PRIVATE KEY-----",
  ]) {
    const data = experiment();
    data.nodes[0].note = value;
    assert.throws(() => validateArtifact({ kind: "experiment", data }), value);
  }
  const data = experiment();
  data.artifacts = [
    {
      title: "Public receipt",
      url: `/api/artifacts/${"e".repeat(64)}`,
      digest: sha("e"),
    },
  ];
  assert.doesNotThrow(() => validateArtifact({ kind: "experiment", data }));
});

test("existing exported game replays remain structurally valid under the new public schema", async () => {
  const directory = resolve(root, "public/data/replays");
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  assert.ok(names.length > 0);
  for (const name of names)
    validateArtifact({
      kind: "replay",
      data: JSON.parse(await readFile(resolve(directory, name), "utf8")),
    });
});

test("approval hashing binds exact inputs while snapshot checks prevent invalid or regressing measured costs", async () => {
  assert.equal(await digest({ b: 2, a: 1 }), await digest({ a: 1, b: 2 }));
  assert.notEqual(
    await digest({ executor: "E0", caps: CAPS }),
    await digest({ executor: "E1", caps: CAPS }),
  );
  const previous = {
    observed: { ...ZERO, tokens: 10 },
    charged: { ...ZERO, tokens: 20 },
  };
  assert.doesNotThrow(() =>
    validateSnapshot(
      { observed: { ...ZERO, tokens: 15 }, charged: { ...ZERO, tokens: 15 } },
      previous,
      CAPS,
    ),
  );
  for (const tokens of [-1, 9, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      validateSnapshot(
        { observed: { ...ZERO, tokens }, charged: { ...ZERO, tokens } },
        previous,
        CAPS,
      ),
    );
  assert.throws(() =>
    validateSnapshot(
      { observed: { ...ZERO, tokens: 30 }, charged: { ...ZERO, tokens: 20 } },
      previous,
      CAPS,
    ),
  );
});

// Run actual route/auth/job-store code, replacing only external identity, D1 and R2.
// This harness deliberately permits interleavings before SQL updates to exercise CAS.
async function backend(t) {
  assert.ok(
    vm.SourceTextModule,
    "Run with node --experimental-vm-modules --test tests/backend-review.test.mjs",
  );
  const sqlite = new DatabaseSync(":memory:");
  for (const name of (await readdir(resolve(root, "drizzle")))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sqlite.exec(await readFile(resolve(root, "drizzle", name), "utf8"));
  t.after(() => sqlite.close());
  let user = {
      userId: "owner",
      email: "admin@example.test",
      fullName: "Operator",
    },
    beforeQuery = null;
  const objects = new Map();
  const env = {
    ARENA_ADMIN_EMAIL: "admin@example.test",
    ARENA_RUNNER_TOKEN: "local-runner-test-token",
    DB: {
      prepare(query) {
        let args = [];
        async function execute(kind) {
          if (beforeQuery) await beforeQuery(query, args);
          const statement = sqlite.prepare(query);
          return kind === "first"
            ? (statement.get(...args) ?? null)
            : kind === "all"
              ? { results: statement.all(...args) }
              : { meta: statement.run(...args) };
        }
        return {
          bind(...values) {
            args = values;
            return this;
          },
          first() {
            return execute("first");
          },
          all() {
            return execute("all");
          },
          run() {
            return execute("run");
          },
        };
      },
    },
    BUCKET: {
      async put(key, raw) {
        objects.set(key, raw);
      },
      async get(key) {
        const raw = objects.get(key);
        return raw === undefined
          ? null
          : {
              body: raw,
              async json() {
                return JSON.parse(raw);
              },
            };
      },
    },
  };
  const context = vm.createContext({
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    Headers,
    Error,
    URL,
    console: { ...console, error() {} },
    setTimeout,
    clearTimeout,
  });
  const cache = new Map();
  function synthetic(name, values) {
    const compiledModule = new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values))
          this.setExport(key, value);
      },
      { context, identifier: name },
    );
    cache.set(name, compiledModule);
    return compiledModule;
  }
  synthetic("zod", { z });
  synthetic("cloudflare:workers", { env });
  synthetic("identity", { getChatGPTUser: async () => user });
  synthetic("history", { default: { experiments: [], replays: {} } });
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    const pending = (async () => {
      const source = stripTypeScriptTypes(await readFile(name, "utf8"), {
        mode: "transform",
      });
      return new vm.SourceTextModule(source, {
        context,
        identifier: pathToFileURL(name).href,
      });
    })();
    cache.set(name, pending);
    return pending;
  }
  const route = await load(resolve(root, "app/api/[...path]/route.ts"));
  await route.link(async (specifier, parent) => {
    if (specifier === "zod" || specifier === "cloudflare:workers")
      return load(specifier);
    if (specifier === "@/app/chatgpt-auth") return load("identity");
    if (specifier.endsWith("history.json")) return load("history");
    const path = specifier.startsWith("@/")
      ? resolve(root, specifier.slice(2))
      : resolve(dirname(fileURLToPath(parent.identifier)), specifier);
    return load(path.endsWith(".ts") ? path : `${path}.ts`);
  });
  await route.evaluate();
  async function request(path, body, options = {}) {
    const method = options.method ?? (body === undefined ? "GET" : "POST");
    const headers = {
      origin: "https://arena.test",
      "content-type": "application/json",
      ...options.headers,
    };
    if (path.startsWith("runner/") && !("authorization" in headers))
      headers.authorization = "Bearer local-runner-test-token";
    const req = new Request(`https://arena.test/api/${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const res = await route.namespace[method](req, {
      params: Promise.resolve({ path: path.split("/") }),
    });
    return { status: res.status, data: await res.json() };
  }
  return {
    sqlite,
    objects,
    env,
    request,
    user(value) {
      user = value;
    },
    hook(value) {
      beforeQuery = value;
    },
    async create({
      public: visible = false,
      key = crypto.randomUUID(),
      live = false,
    } = {}) {
      const result = await request("submissions", {
        title: "Test harness",
        description: "",
        executor: "E0",
        improver: "I0",
        public: visible,
        idempotencyKey: key,
        ...(live ? {} : { evidence: "controlled" }),
      });
      assert.equal(result.status, 201);
      return result.data.submission;
    },
    async approve(j) {
      const result = await request(`ops/${j.id}/approve`, {
        manifestDigest: j.manifestDigest,
        note: "Approved test",
      });
      assert.equal(result.status, 200);
    },
    async claim(workerId = "worker", claimId = crypto.randomUUID()) {
      return request("runner/claim", {
        workerId,
        claimId,
        capabilities: ["arena-v3", "controlled-fixture", "deepseek-flash"],
      });
    },
    async upload(job, kind, data) {
      const raw = JSON.stringify({ kind, data }),
        artifact = await hash(raw);
      const result = await request(
        `runner/jobs/${job.id}/artifacts/${artifact}`,
        raw,
        {
          method: "PUT",
          headers: {
            "x-lease-id": job.leaseId,
            "x-lease-epoch": String(job.leaseEpoch),
          },
        },
      );
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return artifact;
    },
  };
}
const zeroSnapshot = () => ({ observed: { ...ZERO }, charged: { ...ZERO } });
const progress = (job, seq = 1) => ({
  leaseId: job.leaseId,
  leaseEpoch: job.leaseEpoch,
  seq,
  budget: zeroSnapshot(),
});
async function running(b, visible = false, live = false) {
  const submission = await b.create({ public: visible, live });
  await b.approve(submission);
  const claimed = await b.claim();
  assert.equal(claimed.status, 200);
  assert.ok(claimed.data.job);
  return claimed.data.job;
}

test("API binds approval hash, submission idempotency, origin, ownership and runner credentials", async (t) => {
  const b = await backend(t),
    submission = await b.create({ key: "idempotency-test" });
  assert.equal(
    (
      await b.request(`ops/${submission.id}/approve`, {
        manifestDigest: sha("f"),
        note: "Approve wrong hash",
      })
    ).status,
    409,
  );
  assert.equal(
    b.sqlite.prepare("SELECT status FROM jobs").get().status,
    "awaiting_approval",
  );
  assert.equal((await b.create({ key: "idempotency-test" })).id, submission.id);
  assert.equal(
    (
      await b.request("submissions", {
        title: "Changed harness",
        description: "",
        executor: "E1",
        improver: "I0",
        public: false,
        idempotencyKey: "idempotency-test",
        evidence: "controlled",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await b.request(
        "runner/claim",
        {
          workerId: "other",
          claimId: "wrong-token",
          capabilities: ["arena-v3"],
        },
        { headers: { authorization: "Bearer wrong" } },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await b.request(
        `ops/${submission.id}/approve`,
        { manifestDigest: submission.manifestDigest, note: "Origin rejected" },
        { headers: { origin: "https://other.test" } },
      )
    ).status,
    403,
  );
  b.user({ userId: "other", email: "other@example.test" });
  assert.equal(
    (await b.request(`submissions/${submission.id}/cancel`, {})).status,
    404,
  );
  assert.equal(
    (
      await b.request(`ops/${submission.id}/approve`, {
        manifestDigest: submission.manifestDigest,
        note: "Not admin",
      })
    ).status,
    403,
  );
});

test("concurrent claims select one job, exact retry keeps the lease, and expiration never requeues work", async (t) => {
  const b = await backend(t),
    first = await b.create(),
    second = await b.create();
  await b.approve(first);
  await b.approve(second);
  const results = await Promise.all(
    ["w1", "w2", "w3"].map((worker) => b.claim(worker, `${worker}-claim-id`)),
  );
  assert.equal(results.filter((r) => r.data.job).length, 1);
  const index = results.findIndex((r) => r.data.job),
    job = results[index].data.job;
  assert.equal(
    (await b.claim(`w${index + 1}`, `w${index + 1}-claim-id`)).data.job.leaseId,
    job.leaseId,
  );
  b.sqlite
    .prepare("UPDATE jobs SET lease_until=? WHERE id=?")
    .run(Date.now() - 1, job.id);
  assert.equal(
    (
      await b.request(`runner/jobs/${job.id}/heartbeat`, {
        ...progress(job),
        phase: "late",
      })
    ).status,
    409,
  );
  await b.request("catalog");
  assert.equal(
    b.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "needs_recovery",
  );
  assert.equal(
    (await b.claim(`w${index + 1}`, `w${index + 1}-claim-id`)).status,
    409,
  );
});

test("cancel wins races with heartbeat and finalize; stale snapshots cannot overwrite newer progress", async (t) => {
  const b = await backend(t),
    job = await running(b);
  let injected = false;
  b.hook((query) => {
    if (!injected && query.startsWith("UPDATE jobs SET budget=")) {
      injected = true;
      b.sqlite
        .prepare("UPDATE jobs SET status='cancel_requested' WHERE id=?")
        .run(job.id);
    }
  });
  const heartbeat = await b.request(`runner/jobs/${job.id}/heartbeat`, {
    ...progress(job),
    phase: "working",
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.data.cancel, true);
  b.hook(null);
  assert.equal(
    (
      await b.request(`runner/jobs/${job.id}/finalize`, {
        ...progress(job, 2),
        experimentArtifact: "a".repeat(64),
      })
    ).status,
    409,
  );
  b.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
  injected = false;
  b.hook((query) => {
    if (!injected && query.startsWith("UPDATE jobs SET budget=")) {
      injected = true;
      b.sqlite.prepare("UPDATE jobs SET seq=9 WHERE id=?").run(job.id);
    }
  });
  assert.equal(
    (
      await b.request(`runner/jobs/${job.id}/heartbeat`, {
        ...progress(job, 2),
        phase: "stale",
      })
    ).status,
    409,
  );
  assert.equal(
    b.sqlite.prepare("SELECT seq FROM jobs WHERE id=?").get(job.id).seq,
    9,
  );
});

test("fail cannot overwrite a concurrently completed job and unsettled budget requires recovery", async (t) => {
  const b = await backend(t),
    job = await running(b);
  let injected = false;
  b.hook((query) => {
    if (!injected && query.startsWith("UPDATE jobs SET status=")) {
      injected = true;
      b.sqlite
        .prepare("UPDATE jobs SET status='completed' WHERE id=?")
        .run(job.id);
    }
  });
  assert.equal(
    (
      await b.request(`runner/jobs/${job.id}/fail`, {
        ...progress(job),
        reason: "late failure",
        unknownOperations: [],
      })
    ).status,
    409,
  );
  assert.equal(
    b.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "completed",
  );
  b.hook(null);
  b.sqlite.prepare("UPDATE jobs SET status='running' WHERE id=?").run(job.id);
  const payload = {
    ...progress(job),
    reason: "Lost measured usage",
    unknownOperations: [],
  };
  payload.budget.charged.matches = 1;
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/fail`, payload)).data.status,
    "needs_recovery",
  );
});

test("finalization is exact-idempotent, unknown work blocks publication, and private artifacts require ownership", async (t) => {
  const b = await backend(t),
    job = await running(b);
  const artifact = await b.upload(job, "experiment", experiment(job.id));
  const heartbeat = {
    ...progress(job),
    phase: "uploading",
    unknownOperations: ["ambiguous-operation"],
  };
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/heartbeat`, heartbeat)).status,
    200,
  );
  const payload = { ...progress(job, 2), experimentArtifact: artifact };
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/finalize`, payload)).status,
    409,
  );
  assert.equal(
    (
      await b.request(`runner/jobs/${job.id}/heartbeat`, {
        ...progress(job, 2),
        phase: "settled",
        unknownOperations: [],
      })
    ).status,
    200,
  );
  payload.seq = 3;
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/finalize`, payload)).status,
    200,
  );
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/finalize`, payload)).status,
    200,
  );
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/finalize`, { ...payload, seq: 4 }))
      .status,
    409,
  );
  b.user(null);
  assert.equal((await b.request(`experiments/${job.id}`)).status, 404);
  assert.equal((await b.request(`artifacts/${artifact}`)).status, 404);
  b.user({ userId: "stranger", email: "stranger@example.test" });
  assert.equal((await b.request(`artifacts/${artifact}`)).status, 404);
  b.user({ userId: "owner", email: "owner@example.test" });
  assert.equal((await b.request(`experiments/${job.id}`)).status, 200);
  assert.equal((await b.request(`artifacts/${artifact}`)).status, 200);
});

test("artifact upload verifies bytes, task ownership and the current lease", async (t) => {
  const b = await backend(t),
    job = await running(b);
  const raw = JSON.stringify({ kind: "experiment", data: experiment() });
  const headers = {
    "x-lease-id": job.leaseId,
    "x-lease-epoch": String(job.leaseEpoch),
  };
  assert.equal(
    (
      await b.request(
        `runner/jobs/${job.id}/artifacts/${"f".repeat(64)}`,
        raw,
        { method: "PUT", headers },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await b.request(
        `runner/jobs/${job.id}/artifacts/${await hash(raw)}`,
        raw,
        { method: "PUT", headers },
      )
    ).status,
    400,
  );
  assert.equal(b.objects.size, 0);
  b.sqlite
    .prepare("UPDATE jobs SET lease_until=? WHERE id=?")
    .run(Date.now() - 1, job.id);
  const own = JSON.stringify({ kind: "experiment", data: experiment(job.id) });
  assert.equal(
    (
      await b.request(
        `runner/jobs/${job.id}/artifacts/${await hash(own)}`,
        own,
        { method: "PUT", headers },
      )
    ).status,
    409,
  );
  assert.equal(b.objects.size, 0);
});

test("cancel arriving during finalization wins the final compare-and-swap", async (t) => {
  const b = await backend(t),
    job = await running(b);
  const artifact = await b.upload(job, "experiment", experiment(job.id));
  let injected = false;
  b.hook((query) => {
    if (!injected && query.startsWith("UPDATE jobs SET status='completed'")) {
      injected = true;
      b.sqlite
        .prepare("UPDATE jobs SET status='cancel_requested' WHERE id=?")
        .run(job.id);
    }
  });
  assert.equal(
    (
      await b.request(`runner/jobs/${job.id}/finalize`, {
        ...progress(job),
        experimentArtifact: artifact,
      })
    ).status,
    409,
  );
  assert.equal(
    b.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "cancel_requested",
  );
});

test("finalization rejects a replay whose seed differs from its match summary", async (t) => {
  const b = await backend(t),
    job = await running(b, false, true);
  const trajectory = replay();
  trajectory.experimentId = job.id;
  trajectory.seed = 59;
  await b.upload(job, "replay", trajectory);
  const result = experiment(job.id, true);
  result.matches = [{ ...match(), experimentId: job.id }];
  result.usage.matches = 1;
  const artifact = await b.upload(job, "experiment", result);
  const payload = { ...progress(job), experimentArtifact: artifact };
  payload.budget.observed.matches = payload.budget.charged.matches = 1;
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/finalize`, payload)).status,
    409,
  );
  assert.equal(
    b.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status,
    "running",
  );
});

test("a settled policy failure can publish its charged match without inventing a replay", async (t) => {
  const b = await backend(t),
    job = await running(b, true, true);
  const result = experiment(job.id, true);
  result.matches = [
    {
      ...match(),
      experimentId: job.id,
      status: "policy_failed",
      score: 0,
      rounds: 0,
      replayUrl: null,
    },
  ];
  result.usage.matches = 1;
  const artifact = await b.upload(job, "experiment", result);
  const payload = { ...progress(job), experimentArtifact: artifact };
  payload.budget.observed.matches = payload.budget.charged.matches = 1;
  assert.equal(
    (await b.request(`runner/jobs/${job.id}/finalize`, payload)).status,
    200,
  );
  b.user(null);
  assert.equal((await b.request(`experiments/${job.id}`)).status, 200);
  assert.equal(
    (await b.request(`replays/${result.matches[0].id}`)).status,
    404,
  );
});

test("two jobs cannot publish different replays under the same public route id", async (t) => {
  const b = await backend(t),
    first = await running(b);
  const original = replay();
  original.experimentId = first.id;
  const originalDigest = await b.upload(first, "replay", original);
  assert.equal(await b.upload(first, "replay", original), originalDigest);
  assert.equal(
    b.sqlite.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n,
    1,
  );
  assert.equal(
    (
      await b.request(`runner/jobs/${first.id}/fail`, {
        ...progress(first),
        reason: "Finished fixture",
        unknownOperations: [],
      })
    ).status,
    200,
  );
  const second = await running(b);
  const conflicting = { ...original, experimentId: second.id };
  const raw = JSON.stringify({ kind: "replay", data: conflicting });
  const response = await b.request(
    `runner/jobs/${second.id}/artifacts/${await hash(raw)}`,
    raw,
    {
      method: "PUT",
      headers: {
        "x-lease-id": second.leaseId,
        "x-lease-epoch": String(second.leaseEpoch),
      },
    },
  );
  assert.equal(response.status, 409);
  assert.equal(
    b.sqlite
      .prepare(
        "SELECT job_id FROM artifacts WHERE kind='replay' AND object_id=?",
      )
      .get(original.id).job_id,
    first.id,
  );
});

test("lease expiration between object storage and SQL registration cannot publish an artifact", async (t) => {
  const b = await backend(t),
    job = await running(b);
  const raw = JSON.stringify({ kind: "experiment", data: experiment(job.id) });
  let injected = false;
  b.hook((query) => {
    if (!injected && query.startsWith("INSERT INTO artifacts")) {
      injected = true;
      b.sqlite
        .prepare("UPDATE jobs SET lease_until=? WHERE id=?")
        .run(Date.now() - 1, job.id);
    }
  });
  const response = await b.request(
    `runner/jobs/${job.id}/artifacts/${await hash(raw)}`,
    raw,
    {
      method: "PUT",
      headers: {
        "x-lease-id": job.leaseId,
        "x-lease-epoch": String(job.leaseEpoch),
      },
    },
  );
  assert.equal(response.status, 409);
  assert.equal(
    b.sqlite.prepare("SELECT COUNT(*) AS n FROM artifacts").get().n,
    0,
  );
  assert.equal(b.objects.size, 1); // Unreferenced upload is private and cannot be served by the API.
  assert.equal((await b.request(`artifacts/${await hash(raw)}`)).status, 404);
});

test("paired audit seeds still must match the exact approved manifest", async (t) => {
  const b = await backend(t), job = await running(b);
  const result = experiment(job.id);
  for (const arm of result.arms) arm.scores[1].seed = 59;
  const artifact = await b.upload(job, "experiment", result);
  assert.equal((await b.request(`runner/jobs/${job.id}/finalize`, { ...progress(job), experimentArtifact: artifact })).status, 409);
  assert.equal(b.sqlite.prepare("SELECT status FROM jobs WHERE id=?").get(job.id).status, "running");
});


test("runner readiness authenticates and verifies storage without claiming work", async (t) => {
  const app = await backend(t);
  const denied = await app.request('runner/health', undefined, {headers:{authorization:'Bearer invalid'}});
  assert.equal(denied.status,401);
  const ready = await app.request('runner/health');
  assert.equal(ready.status,200);
  assert.equal(ready.data.status,'ready');
  assert.equal(ready.data.claimsJob,false);
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,0);
  assert.equal(app.sqlite.prepare('SELECT COUNT(*) AS n FROM runners').get().n,0);
  app.env.BUCKET.get=async()=>{throw new Error('storage unavailable');};
  assert.equal((await app.request('runner/health')).status,500);
});

test('pinned claims never substitute another queued job and retain the same idempotent lease', async (t) => {
  const b = await backend(t), first = await b.create(), target = await b.create();
  await b.approve(first);
  const request={workerId:'scoped-worker',claimId:'scoped-claim-id',jobId:target.id,capabilities:['arena-v3','controlled-fixture']};
  assert.equal((await b.request('runner/claim',request)).data.job,null);
  assert.equal(b.sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status,'queued');
  await b.approve(target);
  const claimed=await b.request('runner/claim',request);
  assert.equal(claimed.status,200); assert.equal(claimed.data.job.id,target.id);
  assert.equal((await b.request('runner/claim',request)).data.job.leaseId,claimed.data.job.leaseId);
  assert.equal((await b.request('runner/claim',{...request,jobId:first.id})).status,409);
  assert.equal(b.sqlite.prepare('SELECT status FROM jobs WHERE id=?').get(first.id).status,'queued');
});
