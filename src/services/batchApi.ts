import type { AIModel, AIPlatform } from './modelConfig'
import { createProviderFetch, providerEndpoint, providerHeaders, type ProviderConnection } from './providerTransport'
import { resolveExecutableModelJsCode } from './modelProtocol'

export type BatchKind = 'openai' | 'anthropic' | 'mistral'
export interface BatchRow { custom_id: string; method?: string; url?: string; body?: Record<string, any>; params?: Record<string, any> }
export interface BatchJob {
  id: string
  platformId: string
  baseUrl: string
  kind: BatchKind
  status: string
  createdAt: string
  outputFileId?: string
  errorFileId?: string
  counts: Record<string, number>
  errors?: unknown
}
export const BATCH_MAX_BYTES = 20 * 1024 * 1024

export function suggestedBatchKind(platform: ProviderConnection, model?: AIModel): BatchKind | null {
  if (model?.apiProtocol === 'custom' || model?.apiProtocol === 'decision') return null
  if (model?.apiProtocol === 'anthropic') return 'anthropic'
  const host = new URL(platform.baseUrl).hostname
  if (host === 'api.mistral.ai') return 'mistral'
  // These providers need different APIs or do not document this file-based contract.
  if (['generativelanguage.googleapis.com', 'api.x.ai', 'api.deepseek.com', 'openrouter.ai'].includes(host)) return null
  return 'openai'
}

export function parseBatchJsonl(text: string, kind: BatchKind, endpoint: string): BatchRow[] {
  if (new TextEncoder().encode(text).byteLength > BATCH_MAX_BYTES) throw new Error('当前导入上限为 20 MiB，请拆分文件')
  const ids = new Set<string>()
  const rows: BatchRow[] = []
  for (const [index, line] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let row: BatchRow
    try { row = JSON.parse(line) } catch { throw new Error(`第 ${index + 1} 行不是合法 JSON`) }
    const fail = (message: string): never => { throw new Error(`第 ${index + 1} 行：${message}`) }
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('必须是对象')
    if (typeof row.custom_id !== 'string' || !row.custom_id.trim()) fail('缺少 custom_id')
    if (ids.has(row.custom_id)) fail('custom_id 重复')
    if (kind === 'anthropic' && !/^[a-zA-Z0-9_-]{1,64}$/.test(row.custom_id)) fail('Anthropic custom_id 仅支持 1–64 位字母、数字、下划线或连字符')
    ids.add(row.custom_id)
    if (row.method && row.method !== 'POST') fail('仅支持 POST')
    if (row.url && row.url !== endpoint) fail('请求端点与所选端点不一致')
    const body = kind === 'anthropic' ? row.params ?? row.body : row.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('缺少请求体 body / params')
    if (typeof body.model !== 'string' || !body.model.trim()) fail('请求体缺少 model')
    if (body.stream === true) fail('Batch 不支持流式输出，请移除 stream 或设置 false')
    if (endpoint === '/v1/responses') {
      if (!(typeof body.input === 'string' && body.input.length) && !(Array.isArray(body.input) && body.input.length)) fail('缺少 input')
    } else if (!Array.isArray(body.messages) || !body.messages.length) fail('缺少 messages')
    if (kind === 'anthropic' && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) fail('Anthropic 必须设置正整数 max_tokens')
    const params = { ...body }
    delete params.stream
    rows.push(kind === 'anthropic' ? { custom_id: row.custom_id, params }
      : kind === 'mistral' ? { custom_id: row.custom_id, body: params }
        : { custom_id: row.custom_id, method: 'POST', url: endpoint, body: params })
  }
  if (!rows.length) throw new Error('请提供至少一条请求')
  if (rows.length > 50000) throw new Error('当前每批最多 50000 条请求，请拆分文件')
  return rows
}

/** Reuse the exact interactive request serializer, without contacting any server. */
export async function batchRowsFromPrompts(platform: ProviderConnection, model: AIModel, prompts: string[]): Promise<string> {
  if (model.apiProtocol === 'custom') throw new Error('自定义 JavaScript 协议不支持生成 Batch 请求')
  if (model.apiProtocol === 'decision') throw new Error('决策模型不能用于生成 Batch 请求，请选择普通的答题模型')
  const code = resolveExecutableModelJsCode(model)
  const process = new Function(`${code}; return processModel;`)()
  const rows: BatchRow[] = []
  for (const [index, prompt] of prompts.entries()) {
    let body: Record<string, any> | undefined
    await process({ messages: [{ role: 'user', content: prompt }], stream: false }, { ...model, ...platform }, async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    })
    if (!body) throw new Error('未能生成请求')
    delete body.stream
    rows.push(model.apiProtocol === 'anthropic' ? { custom_id: `request-${index + 1}`, params: body }
      : { custom_id: `request-${index + 1}`, method: 'POST', url: model.apiProtocol === 'openai-response' ? '/v1/responses' : '/v1/chat/completions', body })
  }
  return rows.map(row => JSON.stringify(row)).join('\n')
}

export class BatchApi {
  private requestFetch: typeof fetch
  constructor(private platform: AIPlatform, readonly kind: BatchKind, requestFetch?: typeof fetch) {
    this.requestFetch = requestFetch || createProviderFetch(platform)
  }
  private get resource() { return this.kind === 'anthropic' ? 'messages/batches' : this.kind === 'mistral' ? 'batch/jobs' : 'batches' }
  private async request(resource: string, init: RequestInit = {}): Promise<Response> {
    const headers = providerHeaders(this.platform, this.kind === 'anthropic' ? 'anthropic' : 'openai-chat')
    // Multipart boundaries must be generated by fetch, even when a user set Content-Type.
    if (init.body instanceof FormData) headers.delete('Content-Type')
    else if (init.body) headers.set('Content-Type', 'application/json')
    const response = await this.requestFetch(providerEndpoint(this.platform.baseUrl, resource), { ...init, headers })
    if (!response.ok) {
      const text = await response.text()
      let detail = text
      try { const data = JSON.parse(text); detail = data.error?.message || data.message || text } catch {}
      throw new Error(`HTTP ${response.status}: ${String(detail).slice(0, 2000)}`)
    }
    return response
  }
  private normalize(data: any, previous?: BatchJob): BatchJob {
    if (!data || typeof data.id !== 'string' || !data.id) throw new Error('上游未返回有效 Batch ID')
    return {
      id: data.id, platformId: this.platform.id, baseUrl: this.platform.baseUrl, kind: this.kind,
      status: String(data.status || data.processing_status || 'unknown').toLowerCase(),
      createdAt: previous?.createdAt || new Date().toISOString(),
      outputFileId: data.output_file_id || data.output_file || undefined,
      errorFileId: data.error_file_id || data.error_file || undefined,
      counts: data.request_counts || { total: data.total_requests ?? 0, completed: data.completed_requests ?? 0, failed: data.failed_requests ?? 0 },
      errors: data.errors,
    }
  }
  private assertJob(job: BatchJob) {
    if (job.platformId !== this.platform.id || job.kind !== this.kind || providerEndpoint(job.baseUrl, this.resource) !== providerEndpoint(this.platform.baseUrl, this.resource)) {
      throw new Error('平台地址已变化，请恢复提交任务时的地址后再操作')
    }
  }
  async create(text: string, endpoint: string, signal?: AbortSignal): Promise<BatchJob> {
    if (!['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(endpoint)) throw new Error('不支持的 Batch 端点')
    if (this.kind === 'anthropic' && endpoint !== '/v1/messages') throw new Error('Anthropic Batch 仅支持 Messages')
    if (this.kind === 'mistral' && endpoint !== '/v1/chat/completions') throw new Error('Mistral Batch 当前支持 Chat')
    if (this.kind === 'openai' && endpoint === '/v1/messages') throw new Error('OpenAI 兼容 Batch 不支持 Messages')
    const rows = parseBatchJsonl(text, this.kind, endpoint)
    if (this.kind === 'anthropic') {
      try {
        return this.normalize(await (await this.request(this.resource, { method: 'POST', body: JSON.stringify({ requests: rows }), signal })).json())
      } catch (error) {
        throw new Error(`创建任务未能确认，请先在提供商控制台检查，避免重复提交。${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const models = new Set(rows.map(row => row.body!.model))
    if (this.kind === 'mistral' && models.size !== 1) throw new Error('Mistral 每批必须使用同一个模型')
    const form = new FormData()
    form.append('purpose', 'batch')
    form.append('file', new Blob([rows.map(row => JSON.stringify(row)).join('\n')], { type: 'application/jsonl' }), 'batch.jsonl')
    const file = await (await this.request('files', { method: 'POST', body: form, signal })).json()
    if (typeof file.id !== 'string' || !file.id) throw new Error('上传成功但上游未返回文件 ID')
    try {
      const body = this.kind === 'mistral' ? { input_files: [file.id], endpoint, model: [...models][0] }
        : { input_file_id: file.id, endpoint, completion_window: '24h' }
      return this.normalize(await (await this.request(this.resource, { method: 'POST', body: JSON.stringify(body), signal })).json())
    } catch (error) {
      // A network failure can occur after the server accepted the job. Never blindly retry a billed POST.
      throw new Error(`文件已上传（${file.id}），创建任务未能确认。请先在提供商控制台检查，避免重复提交。${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async retrieve(job: BatchJob, signal?: AbortSignal): Promise<BatchJob> {
    this.assertJob(job)
    return this.normalize(await (await this.request(`${this.resource}/${encodeURIComponent(job.id)}`, { signal })).json(), job)
  }
  async cancel(job: BatchJob, signal?: AbortSignal): Promise<BatchJob> {
    this.assertJob(job)
    return this.normalize(await (await this.request(`${this.resource}/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', signal })).json(), job)
  }
  async results(job: BatchJob, errors = false, signal?: AbortSignal): Promise<string> {
    this.assertJob(job)
    if (this.kind === 'anthropic') {
      if (job.status !== 'ended') throw new Error('Anthropic 任务尚未结束')
      return (await this.request(`${this.resource}/${encodeURIComponent(job.id)}/results`, { signal })).text()
    }
    const file = errors ? job.errorFileId : job.outputFileId
    if (!file) throw new Error(errors ? '尚无错误文件' : '尚无结果文件')
    return (await this.request(`files/${encodeURIComponent(file)}/content`, { signal })).text()
  }
}

export const isBatchFinished = (job: BatchJob) => ['completed', 'failed', 'cancelled', 'expired', 'ended', 'success', 'timeout_exceeded'].includes(job.status)
