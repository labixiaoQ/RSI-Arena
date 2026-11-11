# Runner HTTP contract v1

The owning cloud implementation is `lib/platform-contract.ts` and `app/api/[...path]/route.ts`. All runner routes require `Authorization: Bearer <runner token>`. Production uses HTTPS. Model credentials never cross these routes. The website alone admits and approves immutable submissions.

## Claim and approval

`POST /api/runner/claim` body `{workerId,claimId,capabilities:["arena-v3","controlled-fixture"]}` returns `{job:null}` or the job below. Optional `jobId` narrows the claim to that exact queued task; missing/unapproved targets return null instead of another job. A retried claim ID cannot switch its original leased task. The runner also checks `ARENA_JOB_ID` before any execution. A locally live-enabled worker also advertises `"deepseek-flash"`; the server filters by both protocol and model capability, so a controlled-only worker leaves live jobs queued.

```json
{
  "job": {
    "id":"run-id",
    "manifest": {
      "schema_version":1,
      "job_id":"run-id",
      "submission_digest":"sha256:...",
      "protocol_id":"arena-v3",
      "model_profile_id":"deepseek-flash",
      "runner_profile_id":"development-container-v1",
      "protocol_digest":"sha256:...",
      "gear_implementation_digest":"sha256:...",
      "image_digest":"sha256:363c67d8186b9a13cb4898f191389ade38d2d534f74dca7e2632659a341cf6f7",
      "epochs":1,
      "audit_seeds":[31,47],
      "duration_ms":3600000,
      "caps":{"agent_calls":50,"model_requests":50,"tokens":1638400,"episodes":12,"matches":72},
      "evidence_kind":"live"
    },
    "manifestDigest":"sha256:...",
    "executor":"E instructions",
    "improver":"I instructions",
    "approval":{"manifestDigest":"sha256:...","caps":{},"approvedAt":"ISO timestamp"},
    "leaseId":"opaque-id",
    "leaseEpoch":1,
    "leaseUntil":1790000000000
  }
}
```

`approval.caps` is the complete identical five-dimensional `manifest.caps`. Manifest digest uses recursively key-sorted JSON and SHA-256 with `sha256:` prefix. `submission_digest` uses the same algorithm on `{executor:{version:1,instruction:E},improver:{version:1,instruction:I}}`. Gear's internal harness/protocol/implementation digests use its own `gear-canonical-v1` algorithm; do not substitute the website algorithm.

E/I must each be nonempty, well-formed Unicode and at most 2048 UTF-8 bytes. Only fixed protocol, model, image and runner profiles are supported. Extra submitted execution fields are rejected. For controlled execution use `evidence_kind:"controlled"` and `model_profile_id:"controlled-fixture"`. Controlled caps may be the fixture plan (50 agent calls, zero provider requests/tokens, 12 episodes, 72 simulated matches) or the conservative live plan above. Gear always receives fixture zero-provider caps, and reports actual provider requests/tokens as zero.

Live requires `ARENA_ENABLE_LIVE=1`, a fresh matching approval, pinned protocol and implementation digests, the fixed image and local model credential. Historic trial permissions are never imported. `--preflight` reports current digests and plans without accessing Docker or the model endpoint.

## Heartbeat and uploads

`POST /api/runner/jobs/:id/heartbeat`: `{leaseId,leaseEpoch,seq,phase,budget:{observed,charged},unknownOperations:[id]}` → `{leaseUntil,cancel}`. Budget counts use the five snake_case dimensions above. Sequence and observed totals are monotonic; charged may decrease when reservations settle. Lease times are milliseconds since epoch (runner also accepts ISO strings).

`PUT /api/runner/jobs/:id/artifacts/:sha256` headers `X-Lease-Id`, `X-Lease-Epoch`, `Content-Type: application/json`; body `{kind:"experiment"|"replay",data:<DTO>}`. URL digest is lowercase hexadecimal SHA-256 of the exact body bytes, not canonical JSON. Maximum 4 MiB. Server returns `{digest:<hex>}`. Experiment ID and each replay's experimentId equal the job ID. Replay URL is `/replays/:id`. Only schema allowlisted public content is uploaded; local paths and raw logs remain private. Controlled fixtures never fabricate game replays.

`POST /api/runner/jobs/:id/finalize`: `{leaseId,leaseEpoch,seq,budget:{observed,charged},experimentArtifact:<hex>,replayArtifacts:[hex]}`. All required uploads precede completion; observed must equal charged and no unresolved operations remain. Lost completion responses may retry only this identical receipt. Local `publication.json` records it before sending.

`POST /api/runner/jobs/:id/fail`: `{leaseId,leaseEpoch,seq,budget:{observed,charged},reason,unknownOperations:[id],cancelled?:boolean}`. Reason is a safe classification, not a raw exception. Unknown work retains its reservation. Stale lease writes return 409.

## Failure ownership

A heartbeat failure immediately cancels the active AbortSignal; a separate lease watchdog also aborts stalled execution. Guard every external dispatch. Started work is never automatically reassigned, a local workspace is never reused by `--once`, and checkpoint/ledger directories are never reset. Lost upload/completion acknowledgments require recovery if final state cannot be established. Current execution isolation is experimental: dedicated host, manual review, no public Docker access.
