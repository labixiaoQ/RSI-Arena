import type { AgentRequest, AgentReply, ModelBackend } from './contracts.js'
import { digest } from './contracts.js'

/** JSON-only calls: candidates receive no filesystem, evaluator or scheduling tools. */
export class HttpModel implements ModelBackend {
  readonly kind = 'live' as const
  readonly identity: string
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly keyEnv: string,
    private readonly maxOutputTokens = 8192,
  ) {
    const url = new URL(endpoint)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search)
      throw new Error('Use a credential-free model endpoint')
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('Invalid token cap')
    this.identity = digest({
      backend: 'chat-completions-v1',
      endpoint,
      model,
      keyEnv,
      maxOutputTokens,
      thinking: 'disabled',
    })
  }
  allowance(request: AgentRequest) {
    // UTF-8 bytes plus framing is a conservative admission allowance, not measured token usage.
    return {
      model_requests: 1,
      tokens: Buffer.byteLength(request.system + request.input) + 1024 + this.maxOutputTokens,
    }
  }
  async complete(request: AgentRequest, signal: AbortSignal): Promise<AgentReply> {
    const key = process.env[this.keyEnv]
    if (!key) throw new Error(`Missing model credential environment variable: ${this.keyEnv}`)
    const response = await fetch(this.endpoint, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: this.maxOutputTokens,
        ...(new URL(this.endpoint).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.input },
        ],
      }),
    })
    if (!response.ok) throw new Error(`Model request failed with HTTP ${response.status}`)
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
      usage?: { total_tokens?: number }
    }
    const output = body.choices?.[0]?.message?.content,
      tokens = body.usage?.total_tokens
    if (!Number.isSafeInteger(tokens) || tokens! < 0)
      throw new Error('Model response lacks output or measured token usage; allowance remains reserved')
    if (body.choices?.[0]?.finish_reason === 'length')
      return {
        output: typeof output === 'string' ? output : '',
        usage: { model_requests: 1, tokens: tokens! },
        invalid_output: { reason: 'truncated', detail: 'Model output was truncated' },
      }
    if (typeof output !== 'string' || !output)
      throw new Error('Model response lacks output or measured token usage; allowance remains reserved')
    return { output, usage: { model_requests: 1, tokens: tokens! } }
  }
}
