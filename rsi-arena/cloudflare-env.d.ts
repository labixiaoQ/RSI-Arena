declare namespace Cloudflare {
  interface Env {
    ARENA_ADMIN_EMAIL?: string;
    ARENA_RUNNER_TOKEN?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
