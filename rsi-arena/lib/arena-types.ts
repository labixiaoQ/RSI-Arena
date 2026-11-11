export type RunState = 'rejected' | 'uploading' | 'budget_exhausted' | 'completed' | 'queued' | 'awaiting_approval' | 'running' | 'cancel_requested' | 'cancelled' | 'needs_recovery' | 'failed';
export type EvidenceKind = 'live' | 'controlled' | 'mock';
export type Counts = { modelRequests: number; tokens: number; matches: number; episodes: number };
export type ArmResult = { id: 'B' | 'C'; label: string; mode: string; score: number | null; gate: string; retainedHarness: string; initialImprover: string; finalImprover: string; scores: { seed: number; score: number; status?: 'completed' | 'task_failed'; failureReason?: string | null }[] };
export type LineageNode = { id: string; label: string; arm: string; epoch: number; state: 'initial' | 'accepted' | 'rejected' | 'invalid' | 'retained'; executor: string; improver: string; note: string };
export type MatchSummary = { id: string; experimentId: string; arm: string; phase: 'training' | 'development' | 'audit'; seed: number; seat: number; score: number; opponent: string; rounds: number; status?: 'complete' | 'policy_failed'; replayUrl: string | null };
export type Experiment = {
  id: string; title: string; summary: string; game: string; status: RunState; evidence: EvidenceKind; protocolId: string; model: string; createdAt: string;
  classification: 'same_harness_repeat' | 'exploratory' | 'controlled_validation'; sameHarness: boolean; amendment: string | null; metricScope: string;
  usage: Counts; limits: Counts; arms: ArmResult[]; nodes: LineageNode[]; edges: { from: string; to: string }[]; matches: MatchSummary[];
  notes: string[]; artifacts: { title: string; url: string; digest?: string }[];
};
export type Replay = {
  dataUrl?: string; id: string; experimentId: string; title: string; board: number[][]; initialPlayers: { id: number; x: number; y: number }[];
  initialMines: { id: number; x: number; y: number; owner: number }[];
  frames: { round: number; players: { id: number; x: number; y: number; blinkCd: number }[]; mines: { id: number; owner: number; point: number; protection: number }[]; gold: number[]; mineCounts: number[]; observers: { id: number; x: number; y: number; owner: number }[] }[];
  winner: number; seed: number; seat: number; rounds: number; sourceDigest: string;
};
export type Submission = { manifestDigest: string; executor: string; improver: string; evidence?: EvidenceKind; id: string; title: string; description: string; status: RunState; createdAt: string; public: boolean; protocolId: string; model: string; plan: Counts; experimentId: string | null; rejectionReason: string | null };
export type SessionInfo = { user: { id: string; name: string } | null; admin: boolean; signInUrl: string; signOutUrl: string };
