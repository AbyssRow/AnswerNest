import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPresetProcessModelJsCode } from '../src/services/modelProtocol'
import { providerEndpoint, providerHeaders, providerClientOptions, validateProxyUrl } from '../src/services/providerTransport'
import { BatchApi, batchRowsFromPrompts, parseBatchJsonl } from '../src/services/batchApi'
import { collectModelOptions } from '../src/services/modelOptionsForm'
import { providers, batchSpecForPlatform, defaultProtocolForPlatform, providerForPlatform } from '../src/services/providerRegistry'
import { adoptRemotePlatforms } from '../src/services/remoteCatalogMigration'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { batchStatusLabel, canDownloadResults, endpointForModel } from '../src/services/batchUi'

const platform: any = { id: 'p1', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key', models: [] }
const model: any = { id: 'm1', modelId: 'gpt-4.1-mini', apiProtocol: 'openai-chat', maxTokens: 2048, temperature: 0, topP: 0.8 }
const jsonResponse = (data: any) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
async function execute(protocol = 'openai-chat', config: any = {}, input: any = {}, response?: Response) {
  const code = buildPresetProcessModelJsCode({ protocol: protocol as any, modelId: config.modelId || model.modelId, ...config })
  const process = new Function(`${code}; return processModel;`)()
  let request: any
  const result = await process({ messages: [{ role: 'user', content: 'hi' }], stream: false, ...input }, { ...model, ...platform, ...config }, async (url: string, init: any) => {
    request = { url, ...init, body: JSON.parse(init.body), headers: new Headers(init.headers) }
    return response || jsonResponse({ choices: [{ message: { content: 'ok' } }] })
  })
  return { result, request }
}

test('base URL joins preserve version, gateway paths, full endpoints, and query', () => {
  for (const [base, expected] of [
    ['https://api.openai.com', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/chat/completions'],
    ['https://host/compatible-mode/v1', 'https://host/compatible-mode/v1/chat/completions'],
    ['https://host/api/v3/chat/completions?x=1', 'https://host/api/v3/chat/completions?x=1'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
  ]) assert.equal(providerEndpoint(base, 'chat/completions'), expected)
  assert.throws(() => providerEndpoint('file:///tmp', 'models'))
})
test('proxy isolation and URL validation', () => {
  assert.equal(providerClientOptions({ proxyUrl: 'socks5h://127.0.0.1:7890' }).proxy?.all, 'socks5h://127.0.0.1:7890')
  assert.deepEqual(providerClientOptions({}), {})
  assert.throws(() => validateProxyUrl('127.0.0.1:7890'))
  assert.throws(() => validateProxyUrl('file:///proxy'))
})
test('official Anthropic authentication and case-insensitive custom headers', async () => {
  const headers = providerHeaders({ ...platform, customHeaders: { 'X-API-Key': 'override' } }, 'anthropic')
  assert.equal(headers.get('x-api-key'), 'override')
  assert.equal(headers.get('authorization'), null)
  const { request } = await execute('anthropic', { baseUrl: 'https://api.anthropic.com/v1', customHeaders: { 'X-API-Key': 'override' } })
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(request.headers.get('x-api-key'), 'override')
  assert.equal(request.headers.get('authorization'), null)
  assert.equal(request.headers.get('anthropic-version'), '2023-06-01')
})
test('OpenAI regular models keep zero sampling but omit foreign thinking parameters', async () => {
  const { request } = await execute()
  assert.equal(request.body.temperature, 0)
  assert.equal(request.body.enable_thinking, undefined)
  assert.equal(request.body.max_tokens, 2048)
})
test('OpenAI reasoning models map tokens and omit incompatible default sampling', async () => {
  const { request } = await execute('openai-chat', { modelId: 'o3-mini', enableThinking: true, thinkingEffort: 'high' })
  assert.equal(request.body.max_completion_tokens, 2048)
  assert.equal(request.body.max_tokens, undefined)
  assert.equal(request.body.temperature, undefined)
  assert.equal(request.body.reasoning_effort, 'high')
})
test('Responses honors output limit, passes system input, and leaves ordinary models reasoning-free', async () => {
  const { request } = await execute('openai-response', {}, { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] })
  assert.equal(request.body.max_output_tokens, 2048)
  assert.equal(request.body.reasoning, undefined)
  assert.equal(request.body.input[0].content[0].text, 'rules')
})
test('DeepSeek and Qwen use their official thinking fields', async () => {
  const deepseek = await execute('openai-chat', { baseUrl: 'https://api.deepseek.com', enableThinking: true, thinkingEffort: 'medium' })
  assert.deepEqual(deepseek.request.body.thinking, { type: 'enabled' })
  assert.equal(deepseek.request.body.reasoning_effort, 'high')
  assert.equal(deepseek.request.body.top_p, 0.95)
  assert.equal(deepseek.request.body.temperature, undefined)
  const qwen = await execute('openai-chat', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', enableThinking: true, topK: 20, thinkingBudget: 4096 })
  assert.equal(qwen.request.body.enable_thinking, true)
  assert.equal(qwen.request.body.top_k, 20)
  assert.equal(qwen.request.body.thinking_budget, 4096)
  assert.equal(qwen.request.body.reasoning_effort, undefined)
})
test('Gemini, OpenRouter and Mistral use separate parameter conventions', async () => {
  const gemini = await execute('openai-chat', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-2.5-flash' })
  assert.equal(gemini.request.body.reasoning_effort, 'none')
  assert.equal(gemini.request.body.enable_thinking, undefined)
  const router = await execute('openai-chat', { baseUrl: 'https://openrouter.ai/api/v1', enableThinking: true })
  assert.deepEqual(router.request.body.reasoning, { effort: 'medium' })
  const mistral = await execute('openai-chat', { baseUrl: 'https://api.mistral.ai/v1', seed: 0 })
  assert.equal(mistral.request.body.random_seed, 0)
  assert.equal(mistral.request.body.seed, undefined)
})
test('Anthropic thinking uses budget_tokens and validates budget', async () => {
  const { request } = await execute('anthropic', { enableThinking: true, thinkingBudget: 1024 })
  assert.deepEqual(request.body.thinking, { type: 'enabled', budget_tokens: 1024 })
  assert.equal(request.body.reasoning, undefined)
  await assert.rejects(execute('anthropic', { enableThinking: true, thinkingBudget: 2048 }), /预算/)
})
test('advanced parameter precedence, omissions, and model IDs containing replacement metacharacters', async () => {
  const { request } = await execute('openai-chat', { modelId: 'vendor/$&-model', seed: 0, extraBody: { temperature: 1.2, response_format: { type: 'json_object' } }, omitParameters: ['top_p'] })
  assert.equal(request.body.model, 'vendor/$&-model')
  assert.equal(request.body.temperature, 1.2)
  assert.equal(request.body.top_p, undefined)
  assert.equal(request.body.seed, 0)
  assert.deepEqual(request.body.response_format, { type: 'json_object' })
})
test('SSE handles CRLF, fragmented UTF-8, and a final unterminated event', async () => {
  const data = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"!"}}]}')
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of data) controller.enqueue(new Uint8Array([byte])); controller.close() } }))
  const { result } = await execute('openai-chat', {}, { stream: true }, response)
  const chunks = []
  for await (const chunk of result) chunks.push(chunk.content)
  assert.deepEqual(chunks, ['你好', '!'])
})
test('SSE upstream errors propagate and release the stream', async () => {
  const response = new Response('data: {"type":"error","error":{"message":"quota exceeded"}}\n\n')
  const { result } = await execute('anthropic', {}, { stream: true }, response)
  await assert.rejects(async () => { for await (const _chunk of result) {} }, /quota exceeded/)
  assert.equal(response.body?.locked, false)
})
test('form validation preserves zero, rejects arrays and reserved fields', () => {
  const values = { maxTokens: '4096', temperature: '0', topP: '1', seed: '0' }
  assert.equal(collectModelOptions(values, '{}', '', '').seed, 0)
  assert.equal(collectModelOptions({ ...values, temperature: 0, seed: 0 }, '{}', '', '').temperature, 0)
  assert.throws(() => collectModelOptions(values, '[]', '', ''))
  assert.throws(() => collectModelOptions(values, '{"model":"override"}', '', ''))
  assert.throws(() => collectModelOptions(values, '{}', '', 'stream'))
  assert.throws(() => collectModelOptions({ ...values, topP: '3' }, '{}', '', ''))
})
test('domestic upstreams preserve their paths and use vendor thinking conventions', async () => {
  const zhipu = await execute('openai-chat', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.3', enableThinking: false })
  assert.equal(zhipu.request.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions')
  assert.equal(zhipu.request.body.thinking, undefined)
  const kimi = await execute('openai-chat', { baseUrl: 'https://api.moonshot.cn/v1', modelId: 'kimi-k2.6' })
  assert.deepEqual(kimi.request.body.thinking, { type: 'disabled' })
  assert.equal(kimi.request.body.temperature, undefined)
  const ark = await execute('openai-chat', { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', enableThinking: true })
  assert.deepEqual(ark.request.body.thinking, { type: 'enabled' })
  assert.equal(ark.request.body.enable_thinking, undefined)
  const silicon = await execute('openai-chat', { baseUrl: 'https://api.siliconflow.cn/v1', enableThinking: true, thinkingBudget: 2048 })
  assert.equal(silicon.request.body.enable_thinking, true)
  assert.equal(silicon.request.body.thinking_budget, 2048)
})
test('xAI reasoning removes unsupported penalty/stop fields', async () => {
  const { request } = await execute('openai-chat', { baseUrl: 'https://api.x.ai/v1', modelId: 'grok-4', frequencyPenalty: 1, presencePenalty: 1, stop: ['end'] })
  assert.equal(request.body.frequency_penalty, undefined)
  assert.equal(request.body.stop, undefined)
})
test('Anthropic adaptive thinking bypasses the manual budget and respects explicit overrides', async () => {
  const { request } = await execute('anthropic', { modelId: 'claude-opus-4-6', enableThinking: true, maxTokens: 512 })
  assert.deepEqual(request.body.thinking, { type: 'adaptive' })
  assert.deepEqual(request.body.output_config, { effort: 'medium' })
  const explicit = await execute('anthropic', { enableThinking: true, maxTokens: 512, extraBody: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } } })
  assert.deepEqual(explicit.request.body.output_config, { effort: 'high' })
})
test('JSON fallback works when an upstream ignores streaming; 200 error envelopes fail clearly', async () => {
  const { result } = await execute('openai-chat', {}, { stream: true }, jsonResponse({ choices: [{ message: { content: 'fallback' } }] }))
  assert.equal(result.content, 'fallback')
  await assert.rejects(execute('openai-chat', {}, {}, jsonResponse({ error: { message: 'denied' } })), /denied/)
})
test('tool continuation serialization for Responses and Anthropic', async () => {
  const messages = [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
  ]
  const responses = await execute('openai-response', {}, { messages })
  assert.equal(responses.request.body.input[1].type, 'function_call')
  assert.equal(responses.request.body.input[2].type, 'function_call_output')
  const anthropic = await execute('anthropic', {}, { messages })
  assert.equal(anthropic.request.body.messages[1].content[0].type, 'tool_use')
  assert.deepEqual(anthropic.request.body.messages[1].content[0].input, { city: '北京' })
  assert.equal(anthropic.request.body.messages[2].content[0].tool_use_id, 'call-1')
})
test('Chat SSE tool deltas retain the initial ID and name across fragments', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
  ]
  const response = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  const { result } = await execute('openai-chat', {}, { stream: true }, response)
  const calls = []
  for await (const chunk of result) calls.push(chunk.tool_calls[0])
  assert.equal(calls[1].id, 'call-1')
  assert.equal(calls[1].function.name, 'lookup')
  assert.equal(calls.map(call => call.function.arguments).join(''), '{}')
})
const row = { custom_id: 'one', method: 'POST', url: '/v1/chat/completions', body: { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }] } }
test('JSONL validates entire input before uploads, rejects duplicates/stream/mismatched endpoint', () => {
  assert.equal(parseBatchJsonl('\uFEFF' + JSON.stringify(row) + '\r\n', 'openai', row.url).length, 1)
  assert.throws(() => parseBatchJsonl([row, row].map(x => JSON.stringify(x)).join('\n'), 'openai', row.url), /重复/)
  assert.throws(() => parseBatchJsonl(JSON.stringify({ ...row, body: { ...row.body, stream: true } }), 'openai', row.url), /流式/)
  assert.throws(() => parseBatchJsonl(JSON.stringify(row), 'openai', '/v1/responses'), /端点/)
  assert.throws(() => parseBatchJsonl('', 'openai', row.url))
})
test('Batch prompt generator reuses interactive parameters and never makes a real request', async () => {
  const text = await batchRowsFromPrompts(platform, { ...model, extraBody: { seed: 42 } }, ['hi', 'hello'])
  const rows = parseBatchJsonl(text, 'openai', '/v1/chat/completions')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].body?.model, model.modelId)
  assert.equal(rows[0].body?.seed, 42)
  assert.equal(rows[0].body?.stream, undefined)
})
test('OpenAI Batch lifecycle uploads multipart, creates job, retrieves, cancels and downloads', async () => {
  const calls: any[] = []
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/files')) {
      assert.ok(init?.body instanceof FormData)
      assert.equal(new Headers(init?.headers).get('content-type'), null)
      assert.equal((init!.body as FormData).get('purpose'), 'batch')
      return jsonResponse({ id: 'file-1' })
    }
    if (String(url).endsWith('/content')) return new Response('{"custom_id":"one","response":{"status_code":200}}\n')
    return jsonResponse({ id: 'batch-1', status: 'completed', output_file_id: 'file-result', error_file_id: 'file-errors', request_counts: { total: 1, completed: 1, failed: 0 } })
  }
  const api = new BatchApi(platform, 'openai', fetcher)
  const job = await api.create(JSON.stringify(row), row.url)
  assert.deepEqual(JSON.parse(calls[1].init.body), { input_file_id: 'file-1', endpoint: row.url, completion_window: '24h' })
  assert.equal((await api.retrieve(job)).status, 'completed')
  await api.cancel(job)
  assert.ok(calls[3].url.endsWith('/batches/batch-1/cancel'))
  assert.match(await api.results(job), /custom_id/)
  await api.results(job, true)
  assert.ok(calls.at(-1).url.endsWith('/files/file-errors/content'))
  await assert.rejects(api.retrieve({ ...job, baseUrl: 'https://elsewhere/v1' }), /地址已变化/)
})
test('OpenAI-style Batch refuses mixed models before uploading anything', async () => {
  const calls: string[] = []
  const api = new BatchApi(platform, 'openai', async (url) => { calls.push(String(url)); return jsonResponse({ id: 'x' }) })
  const other = { ...row, custom_id: 'two', body: { ...row.body, model: 'gpt-4.1' } }
  await assert.rejects(api.create([row, other].map(x => JSON.stringify(x)).join('\n'), row.url), /同一个模型/)
  assert.deepEqual(calls, [])
})
test('Anthropic Batch sends requests directly and downloads from a trusted relative path', async () => {
  const calls: any[] = []
  const api = new BatchApi(platform, 'anthropic', async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/results')) return new Response('{"custom_id":"one","result":{"type":"succeeded"}}')
    return jsonResponse({ id: 'msgbatch_1', processing_status: 'ended', request_counts: { succeeded: 1 }, results_url: 'https://untrusted.example/steal' })
  })
  const job = await api.create(JSON.stringify({ custom_id: 'one', params: { ...row.body, max_tokens: 100 } }), '/v1/messages')
  assert.ok(JSON.parse(calls[0].init.body).requests)
  assert.equal(new Headers(calls[0].init.headers).get('x-api-key'), 'test-key')
  await api.results(job)
  assert.equal(calls[1].url, 'https://api.openai.com/v1/messages/batches/msgbatch_1/results')
})
test('Mistral Batch uses batch/jobs and input_files', async () => {
  const calls: any[] = []
  const api = new BatchApi({ ...platform, baseUrl: 'https://api.mistral.ai/v1' }, 'mistral', async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse(String(url).endsWith('/files') ? { id: 'file-1' } : { id: 'job-1', status: 'SUCCESS', output_file: 'output', completed_requests: 1 })
  })
  const job = await api.create(JSON.stringify(row), row.url)
  assert.equal(calls[1].url, 'https://api.mistral.ai/v1/batch/jobs')
  assert.deepEqual(JSON.parse(calls[1].init.body).input_files, ['file-1'])
  assert.equal(job.status, 'success')
  assert.equal(job.outputFileId, 'output')
})
test('OpenRouter Batch posts requests inline with endpoint/model first, strips :batch, and reads inline results', async () => {
  const calls: any[] = []
  const api = new BatchApi({ ...platform, baseUrl: 'https://openrouter.ai/api/v1' }, 'openrouter', async (url, init) => {
    calls.push({ url: String(url), init })
    if (init?.method === 'POST') return jsonResponse({ id: 'batch_1', status: 'validating', request_counts: { total: 2, completed: 0, failed: 0 } })
    return jsonResponse({ id: 'batch_1', status: 'completed', request_counts: { total: 2, completed: 1, failed: 1 }, results: [
      { id: 'batch_req_1', custom_id: 'request-1', response: { status_code: 200, body: { id: 'gen-batch-1' } } },
      { id: 'batch_req_2', custom_id: 'request-2', error: { message: 'rejected' } },
    ] })
  })
  const text = await batchRowsFromPrompts(platform, { ...model, modelId: 'openai/gpt-4o:batch' }, ['hi', 'hello'])
  const job = await api.create(text, '/v1/chat/completions', undefined, { model: 'openai/gpt-4o:batch' })
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/batches')
  const sent = JSON.parse(calls[0].init.body)
  // key order matters to OpenRouter: endpoint and model before requests
  assert.deepEqual(Object.keys(sent), ['endpoint', 'model', 'requests'])
  assert.equal(sent.model, 'openai/gpt-4o')
  assert.equal(sent.requests.length, 2)
  assert.deepEqual(Object.keys(sent.requests[0]), ['custom_id', 'body'])
  assert.equal(sent.requests[0].body.model, undefined)
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer test-key')
  assert.equal((await api.retrieve(job)).status, 'completed')
  const all = (await api.results(job)).split('\n')
  assert.equal(all.length, 2)
  assert.deepEqual((await api.results(job, true)).split('\n').map(line => JSON.parse(line).custom_id), ['request-2'])
  await assert.rejects(api.cancel(job), /没有取消接口/)
})
test('OpenRouter Batch rejects mixed models, :online variants and stream', async () => {
  const api = new BatchApi({ ...platform, baseUrl: 'https://openrouter.ai/api/v1' }, 'openrouter', async () => jsonResponse({}))
  const mk = (id: string, m?: string) => JSON.stringify({ custom_id: id, body: { ...(m ? { model: m } : {}), messages: [{ role: 'user', content: 'hi' }] } })
  await assert.rejects(api.create([mk('a', 'openai/gpt-4o'), mk('b', 'anthropic/claude-sonnet-4')].join('\n'), '/v1/chat/completions'), /一个模型/)
  await assert.rejects(api.create(mk('a'), '/v1/chat/completions', undefined, { model: 'openai/gpt-4o:online' }), /:online/)
  await assert.rejects(api.create(mk('a'), '/v1/chat/completions'), /指定/)
  assert.throws(() => parseBatchJsonl(JSON.stringify({ custom_id: 'a', body: { stream: true, messages: [{ role: 'user', content: 'x' }] } }), 'openrouter', '/v1/chat/completions'), /流式/)
})
test('provider registry: known providers carry protocol and batch spec, custom ones default to none', () => {
  const byId = Object.fromEntries(providers.map(p => [p.id, p]))
  assert.equal(byId.anthropic.apiStyle, 'anthropic')
  assert.equal(byId.openrouter.batch, 'openrouter')
  assert.equal(byId.openai.batch, 'openai')
  assert.equal(byId.mistral.batch, 'mistral')
  assert.equal(new Set(providers.map(p => p.id)).size, providers.length)
  for (const p of providers) assert.doesNotThrow(() => new URL(p.baseUrl), p.id)
  // saved provider wins; legacy platforms are recognised by host; custom has no batch
  assert.equal(providerForPlatform({ provider: 'groq', baseUrl: 'https://gateway.example.com/v1' })?.id, 'groq')
  assert.equal(providerForPlatform({ baseUrl: 'https://api.anthropic.com/v1' })?.id, 'anthropic')
  assert.equal(batchSpecForPlatform({ provider: 'custom', baseUrl: 'https://openrouter.ai/api/v1' }), null)
  assert.equal(batchSpecForPlatform({ baseUrl: 'https://unknown.example.com/v1' }), null)
  assert.equal(defaultProtocolForPlatform({ provider: 'custom', apiStyle: 'openai-response' }), 'openai-response')
  assert.equal(defaultProtocolForPlatform({ baseUrl: 'https://api.anthropic.com/v1' }), 'anthropic')
  assert.equal(defaultProtocolForPlatform({ baseUrl: 'https://nowhere.example/v1' }), 'openai-chat')
})
test('batch UI helpers: status labels, download availability and endpoint by model protocol', () => {
  assert.equal(batchStatusLabel('in_progress'), '处理中')
  assert.equal(batchStatusLabel('some_new_status'), 'some_new_status')
  const job = (kind: any, status: string, extra: any = {}) => ({ id: 'x', platformId: 'p', baseUrl: 'u', kind, status, createdAt: '', counts: {}, ...extra })
  assert.equal(canDownloadResults(job('openrouter', 'completed') as any), true)
  assert.equal(canDownloadResults(job('openrouter', 'in_progress') as any), false)
  assert.equal(canDownloadResults(job('anthropic', 'ended') as any), true)
  assert.equal(canDownloadResults(job('openai', 'completed') as any), false)
  assert.equal(canDownloadResults(job('openai', 'completed', { outputFileId: 'f' }) as any), true)
  assert.equal(endpointForModel('openai', { apiProtocol: 'openai-response' }), '/v1/responses')
  assert.equal(endpointForModel('mistral', { apiProtocol: 'openai-response' }), '/v1/chat/completions')
  assert.equal(endpointForModel('openrouter', { apiProtocol: 'anthropic' }), '/v1/messages')
})
test('Anthropic thinking follows each Claude model family (adaptive-only models reject type enabled)', async () => {
  const think = async (modelId: string, on: boolean, extra: any = {}) =>
    (await execute('anthropic', { modelId, enableThinking: on, ...extra })).request.body
  // 4.7+/5.x are adaptive-only, including Haiku 5.5, Fable and Mythos, and gateway-prefixed ids
  for (const id of ['claude-haiku-5-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'anthropic/claude-opus-5-5']) {
    const body = await think(id, true)
    assert.deepEqual(body.thinking, { type: 'adaptive' }, id)
    assert.equal(body.output_config.effort, 'medium', id)
  }
  // effort max is a valid output_config.effort and must not be clamped to high
  assert.equal((await think('claude-opus-5-5', true, { thinkingEffort: 'max' })).output_config.effort, 'max')
  // legacy Claude and non-Claude Anthropic-compatible endpoints keep the manual budget
  for (const id of ['claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet-20250219', 'claude-sonnet-4-20250514', 'kimi-for-coding', 'deepseek-chat']) {
    assert.deepEqual((await think(id, true)).thinking, { type: 'enabled', budget_tokens: 1024 }, id)
  }
  assert.equal((await think('claude-sonnet-4-6', true)).thinking.type, 'adaptive')
  // the user can still force a mode
  assert.equal((await think('claude-opus-4-6', true, { thinkingMode: 'budget' })).thinking.type, 'enabled')
  // turning thinking off: always-on models get no thinking field (disabled would be a 400)
  for (const id of ['claude-opus-5-5', 'claude-fable-5', 'claude-mythos-5-1']) assert.equal((await think(id, false)).thinking, undefined, id)
  assert.deepEqual((await think('claude-sonnet-5-5', false)).thinking, { type: 'between_tools' })
  for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5']) assert.deepEqual((await think(id, false)).thinking, { type: 'disabled' }, id)
  // models that default to off need nothing; non-Claude models never get thinking when off
  for (const id of ['claude-opus-4-8', 'claude-opus-4-5', 'kimi-for-coding']) assert.equal((await think(id, false)).thinking, undefined, id)
})
test('GPT-6 is a reasoning family: no sampling params, max passes through, thinking off never sends none/minimal', async () => {
  const chat = (await execute('openai-chat', { modelId: 'gpt-6.1-sol', enableThinking: true, thinkingEffort: 'max' })).request.body
  assert.equal(chat.reasoning_effort, 'max')
  assert.equal(chat.temperature, undefined)
  assert.equal(chat.top_p, undefined)
  assert.equal(chat.max_tokens, undefined)
  assert.ok(chat.max_completion_tokens > 0)
  // older OpenAI reasoning families top out at high
  assert.equal((await execute('openai-chat', { modelId: 'gpt-5.5', enableThinking: true, thinkingEffort: 'max' })).request.body.reasoning_effort, 'high')
  const resp = (await execute('openai-response', { modelId: 'gpt-6-astra', enableThinking: true, thinkingEffort: 'high' })).request.body
  assert.equal(resp.reasoning.effort, 'high')
  assert.equal(resp.temperature, undefined)
  const off = (await execute('openai-response', { modelId: 'gpt-6.1-sol', enableThinking: false, upstream: 'compatible' })).request.body
  assert.equal(off.reasoning, undefined)
})
test('legacy remote platforms become ordinary local ones; unconfigured ones are dropped; promo fields and stale icons are stripped', () => {
  const model = (id: string, extra: any = {}) => ({ id, platformId: 'x', name: id, displayName: id, maxTokens: 1, temperature: 0, topP: 1, enabled: true, category: 'text', ...extra })
  const input: any[] = [
    // never configured: no key, only catalog models -> removed
    { id: 'p_unused', name: 'Unused', displayName: 'Unused', baseUrl: 'https://a/v1', apiKey: '', enabled: true, isRemote: true, inviteCode: 'ABC', models: [model('m1', { isRemote: true })] },
    // has a key: kept, unlocked, promo stripped, catalog icon reference dropped, models unlocked
    { id: 'p_keyed', name: 'Keyed', displayName: 'Keyed', baseUrl: 'https://b/v1', apiKey: 'sk-1', enabled: true, isRemote: true, icon: 'openai.svg', inviteUrl: 'https://x', inviteText: '邀请', inviteCode: 'ABC', models: [model('m2', { isRemote: true, icon: 'gpt.svg' })] },
    // no key but the user added a model of their own: kept
    { id: 'p_own', name: 'Own', displayName: 'Own', baseUrl: 'https://c/v1', apiKey: '', enabled: true, isRemote: true, models: [model('m3', { isRemote: true }), model('m4', { isRemote: false })] },
    // user-created platform: untouched (emoji icon kept)
    { id: 'custom_1', name: 'Mine', displayName: 'Mine', baseUrl: 'https://d/v1', apiKey: '', enabled: true, icon: '🤖', models: [] },
    // user-created platform with a stale catalog icon name: only the icon reference goes
    { id: 'custom_2', name: 'Mine2', displayName: 'Mine2', baseUrl: 'https://e/v1', apiKey: '', enabled: true, icon: 'deepseek.svg', models: [] },
  ]
  const result = adoptRemotePlatforms(input)
  assert.equal(result.changed, true)
  assert.deepEqual(result.removedPlatformIds, ['p_unused'])
  assert.deepEqual(result.platforms.map(p => p.id), ['p_keyed', 'p_own', 'custom_1', 'custom_2'])
  const keyed: any = result.platforms[0]
  assert.equal(keyed.isRemote, false)
  assert.equal(keyed.apiKey, 'sk-1')
  assert.equal(keyed.icon, undefined)
  for (const field of ['inviteUrl', 'inviteText', 'inviteCode']) assert.equal(keyed[field], undefined, field)
  assert.equal(keyed.models[0].isRemote, false)
  assert.equal(keyed.models[0].icon, undefined)
  assert.deepEqual(result.platforms[1].models.map(m => m.isRemote), [false, false])
  assert.equal(result.platforms[2].icon, '🤖')
  assert.equal(result.platforms[3].icon, undefined)
  // idempotent: running again changes nothing
  const again = adoptRemotePlatforms(result.platforms)
  assert.equal(again.changed, false)
  assert.deepEqual(again.removedPlatformIds, [])
  // user-provided http(s)/data icons survive
  const kept = adoptRemotePlatforms([{ id: 'custom_3', name: 'K', displayName: 'K', baseUrl: 'https://f/v1', apiKey: '', enabled: true, icon: 'https://example.com/i.png', models: [] } as any])
  assert.equal(kept.changed, false)
})
test('no address belonging to the original author is left in the app, config or docs', () => {
  // 测试从仓库根目录运行（npm run test:model-api）；打包后的测试文件在 tmp/ 下，不能用 import.meta.url 推算根目录
  const root = process.cwd()
  const forbidden = /zerror\.cc|zaizhexue|pd\.qq\.com|picui\.cn/i
  const targets = ['src', 'src-tauri/src', 'src-tauri/capabilities', 'src-tauri/tauri.conf.json', 'index.html', 'README.md', 'docs']
  const found: string[] = []
  let scanned = 0
  const walk = (rel: string) => {
    const full = join(root, rel)
    if (!existsSync(full)) return
    if (statSync(full).isDirectory()) { for (const name of readdirSync(full)) walk(join(rel, name)); return }
    if (!/\.(ts|vue|rs|html|json|md|css|js|mjs|toml)$/i.test(rel)) return
    scanned++
    if (forbidden.test(readFileSync(full, 'utf8'))) found.push(rel)
  }
  targets.forEach(walk)
  // 防止因为路径不对、什么都没扫就“通过”
  assert.ok(scanned > 50, `只扫描了 ${scanned} 个文件，路径可能不对`)
  assert.deepEqual(found, [])
})
test('third-party OpenAI-compatible relays get each model\'s official parameters, whatever the host', async () => {
  const relay = { baseUrl: 'https://relay.example.com/v1' }
  const chat = async (modelId: string, on: boolean) => (await execute('openai-chat', { ...relay, modelId, enableThinking: on })).request.body
  // plain GPT keeps the classic parameters and never receives reasoning switches
  for (const on of [false, true]) {
    const body = await chat('gpt-4.1', on)
    assert.deepEqual([body.temperature, body.top_p, body.max_tokens], [0, 0.8, 2048])
    assert.equal(body.reasoning_effort, undefined)
    assert.equal(body.enable_thinking, undefined)
  }
  // reasoning GPT / o-series: max_completion_tokens, no sampling, no Qwen-style switch, vendor prefix tolerated
  for (const id of ['gpt-5', 'gpt-6.1-sol', 'o3', 'openai/gpt-5']) {
    const off = await chat(id, false)
    assert.ok(off.max_completion_tokens > 0, id)
    for (const name of ['max_tokens', 'temperature', 'top_p', 'enable_thinking', 'reasoning_effort']) assert.equal(off[name], undefined, `${id} ${name}`)
    assert.equal((await chat(id, true)).reasoning_effort, 'medium', id)
  }
  // Claude over the OpenAI-style endpoint: never both temperature and top_p; 4.6+ takes no sampling at all
  for (const id of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'anthropic/claude-opus-5-5']) {
    const body = await chat(id, false)
    assert.equal(body.temperature, undefined, id)
    assert.equal(body.top_p, undefined, id)
    assert.ok(body.max_tokens > 0, id)
  }
  const oldClaude = await chat('claude-sonnet-4-5', false)
  assert.equal(oldClaude.temperature, 0)
  assert.equal(oldClaude.top_p, undefined)
  // Responses: non-reasoning GPT never gets a reasoning object, even when thinking is off on a relay
  for (const on of [false, true]) assert.equal((await execute('openai-response', { ...relay, modelId: 'gpt-4.1', enableThinking: on })).request.body.reasoning, undefined)
  assert.equal((await execute('openai-response', { ...relay, modelId: 'gpt-5', enableThinking: true })).request.body.reasoning.effort, 'medium')
})
test('decision model answers only choice and judgement questions', async () => {
  const { decisionKindFromPrompt, decisionCanAnswer, buildDecisionPayload, formatDecisionAnswer, decisionEndpoint } = await import('../src/services/decisionApi')
  const single = '【题目类型：单选题】\n【题目】\n1+1=?\n【选项】\nA. 2\nB. 3\n\n请作答'
  const multiple = '【题目类型：多选题】\n【题目】\n输入设备有\n【选项】\nA. 键盘\nB. 显示器\nC. 鼠标\n\n请作答'
  const judgement = '【题目类型：判断题】\n【题目】\n地球绕太阳转。\n\n请作答'
  assert.equal(decisionKindFromPrompt(single), 'single')
  assert.equal(decisionKindFromPrompt('【题目类型：填空题】\n【题目】\n首都是____'), null)
  assert.equal(decisionCanAnswer(single, true), false)
  const singlePayload = buildDecisionPayload('decision-model-preview', single) as any
  assert.equal(singlePayload.questions.answer.type, 'choice')
  assert.deepEqual(Object.keys(singlePayload.questions.answer.criteria), ['2', '3'])
  assert.equal(formatDecisionAnswer({ answers: { answer: { choice: '2' } } }, singlePayload), '{"answer":"2"}')
  const multiPayload = buildDecisionPayload('decision-model-preview', multiple) as any
  assert.equal(multiPayload.questions.opt0.type, 'noul')
  assert.equal(formatDecisionAnswer({ answers: { opt0: { noul: 0.9 }, opt1: { noul: 0.1 }, opt2: { noul: 0.8 } } }, multiPayload), '{"answer":"键盘###鼠标"}')
  const judgePayload = buildDecisionPayload('decision-model-preview', judgement) as any
  assert.equal(formatDecisionAnswer({ answers: { judge: { noul: 0.2 } } }, judgePayload), '{"answer":"错误"}')
  assert.equal(formatDecisionAnswer({ answers: [{ name: 'judge', probability: 0.8 }] }, judgePayload), '{"answer":"正确"}')
  assert.equal(decisionCanAnswer(judgement), true)
  const material = '【题目类型：单选题】\n【题目】\n阅读【材料】后作答\n甲说对\n【选项】\nA. 甲\nB. 乙\n\n请作答'
  const materialPayload = buildDecisionPayload('typesafe/jev-1.13', material) as any
  assert.match(materialPayload.state, /【材料】/)
  assert.deepEqual(Object.keys(materialPayload.questions.answer.criteria), ['甲', '乙'])
  assert.equal(decisionEndpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1/systemone')
  assert.equal(decisionEndpoint('https://example.com/custom/decisions'), 'https://example.com/custom/decisions')
  assert.equal(buildDecisionPayload('', single), null)
})
test('image questions only use vision-capable answer models', async () => {
  const { pickAnswerModels, findImageUrls, findFileUrls, questionHasImages, modelSupportsVision } = await import('../src/utils/questionAttachments')
  const text = { id: 't', supportsVision: false }
  const vision = { id: 'v', supportsVision: true }
  assert.deepEqual(pickAnswerModels([text, vision], false).map(m => m.id), ['t', 'v'])
  assert.deepEqual(pickAnswerModels([text, vision], true).map(m => m.id), ['v'])
  assert.deepEqual(findImageUrls('见图 https://cdn.example.com/a.png?x=1 和 https://cdn.example.com/note.pdf'), ['https://cdn.example.com/a.png?x=1'])
  assert.deepEqual(findFileUrls('见图 https://cdn.example.com/a.png 和 https://cdn.example.com/note.pdf'), ['https://cdn.example.com/note.pdf'])
  assert.equal(questionHasImages('纯文本', ['data:image/png;base64,aaa']), true)
  assert.equal(questionHasImages('https://example.com/page'), false)
  assert.equal(modelSupportsVision({ category: 'vision' }), true)
  assert.equal(modelSupportsVision({ supportsVision: false, category: 'text' }), false)
})
test('billed Batch creation is not retried on uncertain network errors', async () => {
  let count = 0
  const api = new BatchApi(platform, 'openai', async () => { count++; if (count === 1) return jsonResponse({ id: 'file-recover' }); throw new Error('network lost') })
  await assert.rejects(api.create(JSON.stringify(row), row.url), /file-recover/)
  assert.equal(count, 2)
})
test('web search: query comes from the title, options only when configured or the title is short', async () => {
  const { buildSearchQuery, extractQuestionParts, cleanQuestionText } = await import('../src/services/webSearch')
  const prompt = (title: string, options = '') => `你是一个专业的答题助手。\n\n【题目类型：单选题】\n【题目】\n${title}\n${options ? `【选项】\n${options}\n` : ''}\n请作答，并在最后输出答案 JSON：`
  const long = '光合作用中，植物吸收的二氧化碳最终被固定到哪种有机物中？'
  const opts = 'A. 葡萄糖\nB. 蛋白质'
  assert.deepEqual(extractQuestionParts(prompt(long, opts)), { title: long, options: 'A. 葡萄糖 B. 蛋白质' })
  assert.equal(buildSearchQuery(prompt(long, opts), { optionsMode: 'never', maxQueryChars: 300 }), long)
  assert.equal(buildSearchQuery(prompt(long, opts), { optionsMode: 'auto', maxQueryChars: 300 }), long)
  assert.equal(buildSearchQuery(prompt(long, opts), { optionsMode: 'always', maxQueryChars: 300 }), `${long} A. 葡萄糖 B. 蛋白质`)
  // a generic stem is useless alone, so auto adds the options
  assert.equal(buildSearchQuery(prompt('下列说法正确的是', opts), { optionsMode: 'auto', maxQueryChars: 300 }), '下列说法正确的是 A. 葡萄糖 B. 蛋白质')
  assert.equal(buildSearchQuery(prompt('下列说法正确的是', opts), { optionsMode: 'never', maxQueryChars: 300 }), '下列说法正确的是')
  assert.equal(buildSearchQuery(prompt(long), { optionsMode: 'always', maxQueryChars: 10 }), long.slice(0, 10))
  assert.equal(buildSearchQuery(prompt('  \n '), { optionsMode: 'always', maxQueryChars: 300 }), '')
  // not our prompt format: use the whole text
  assert.equal(buildSearchQuery('中国的首都是哪里', { optionsMode: 'never', maxQueryChars: 300 }), '中国的首都是哪里')
  assert.equal(cleanQuestionText('【单选题】1. 水的化学式是____。'), '水的化学式是 。')
  assert.equal(cleanQuestionText('12、地球绕太阳公转一周约（ ）天'), '地球绕太阳公转一周约 天')
})
test('web search: Firecrawl and Exa requests follow the official parameters', async () => {
  const { buildFirecrawlRequest, buildExaRequest, normalizeWebSearchConfig } = await import('../src/services/webSearch')
  const base = normalizeWebSearchConfig({ enabled: true, apiKey: 'k', maxResults: 4, timeoutSec: 20 })
  const fc = buildFirecrawlRequest(base, '问题')
  assert.equal(fc.url, 'https://api.firecrawl.dev/v2/search')
  assert.equal(fc.headers.Authorization, 'Bearer k')
  assert.deepEqual(fc.body, { query: '问题', limit: 4, sources: ['web'], timeout: 20000, scrapeOptions: { formats: [{ type: 'markdown' }], onlyMainContent: true } })
  const fcDomains = buildFirecrawlRequest({ ...base, firecrawlScrape: false, baseUrl: 'https://fc.example.com/', includeDomains: 'https://zhihu.com/a, baike.baidu.com', excludeDomains: 'x.com' }, 'q')
  assert.equal(fcDomains.url, 'https://fc.example.com/v2/search')
  assert.equal('scrapeOptions' in fcDomains.body, false)
  assert.deepEqual(fcDomains.body.includeDomains, ['zhihu.com', 'baike.baidu.com'])
  assert.equal('excludeDomains' in fcDomains.body, false)
  const fcExclude = buildFirecrawlRequest({ ...base, excludeDomains: 'a.com b.com' }, 'q')
  assert.deepEqual(fcExclude.body.excludeDomains, ['a.com', 'b.com'])

  const exa = buildExaRequest({ ...base, provider: 'exa', exaType: 'fast' }, '问题')
  assert.equal(exa.url, 'https://api.exa.ai/search')
  assert.equal(exa.headers['x-api-key'], 'k')
  assert.deepEqual(exa.body, { query: '问题', type: 'fast', numResults: 4, contents: { highlights: { maxCharacters: 2000 } } })
  const exaText = buildExaRequest({ ...base, provider: 'exa', exaContent: 'text', maxCharsPerResult: 5000, includeDomains: 'a.com', excludeDomains: 'b.com' }, 'q')
  assert.deepEqual(exaText.body.contents, { text: { maxCharacters: 5000 } })
  assert.deepEqual([exaText.body.includeDomains, exaText.body.excludeDomains], [['a.com'], ['b.com']])
  assert.throws(() => buildExaRequest({ ...base, provider: 'exa', baseUrl: 'ftp://x' }, 'q'), /HTTP/)
})
test('web search: config from a settings file is clamped and defaulted', async () => {
  const { normalizeWebSearchConfig, webSearchReady } = await import('../src/services/webSearch')
  const empty = normalizeWebSearchConfig(undefined)
  assert.equal(empty.enabled, false)
  assert.equal(empty.maxResults, 3)
  assert.equal(empty.optionsMode, 'auto')
  assert.equal(empty.firecrawlScrape, true)
  const messy = normalizeWebSearchConfig({ enabled: true, provider: 'bogus' as any, apiKey: '  key ', maxResults: 99, timeoutSec: -4, maxCharsPerResult: 'x' as any, exaType: 'slow' as any, optionsMode: 'bad' as any })
  assert.deepEqual([messy.provider, messy.apiKey, messy.maxResults, messy.timeoutSec, messy.maxCharsPerResult, messy.exaType, messy.optionsMode], ['firecrawl', 'key', 10, 3, 2000, 'auto', 'auto'])
  assert.equal(webSearchReady(messy), true)
  assert.equal(webSearchReady({ ...messy, apiKey: '' }), false)
  assert.equal(webSearchReady({ ...messy, enabled: false }), false)
})
test('web search: results of both services are parsed into readable context', async () => {
  const { parseFirecrawlResponse, parseExaResponse, formatSearchContext } = await import('../src/services/webSearch')
  const fc = parseFirecrawlResponse({ success: true, data: { web: [
    { title: ' 标题 一 ', url: 'https://a.com', description: '摘要', markdown: '正文'.repeat(10) },
    { title: '二', url: 'https://b.com', description: '只有摘要' },
    { url: 'https://empty.com' }
  ] } }, 12)
  assert.equal(fc.length, 2)
  assert.deepEqual(fc[0], { title: '标题 一', url: 'https://a.com', content: '正文正文正文正文正文正文…' })
  assert.equal(fc[1].content, '只有摘要')
  assert.equal(parseFirecrawlResponse({ data: [{ title: 'old', url: 'u', description: 'd' }] }, 100)[0].content, 'd')
  const exa = parseExaResponse({ results: [{ title: 'T', url: 'https://c.com', highlights: ['片段一', '片段二'] }, { title: 'U', url: 'https://d.com', text: '全文' }] }, 100)
  assert.equal(exa[0].content, '片段一\n…\n片段二')
  assert.equal(exa[1].content, '全文')
  assert.equal(formatSearchContext([...fc, ...exa].slice(0, 2)), '[1] 标题 一\nhttps://a.com\n正文正文正文正文正文正文…\n\n[2] 二\nhttps://b.com\n只有摘要')
  assert.deepEqual(parseExaResponse({}, 10), [])
})
test('web search: runWebSearch reports success, failures and timeouts without throwing', async () => {
  const { runWebSearch, normalizeWebSearchConfig } = await import('../src/services/webSearch')
  const prompt = '【题目】\n中国的首都是哪个城市\n\n请作答'
  const config = normalizeWebSearchConfig({ enabled: true, apiKey: 'k', provider: 'firecrawl' })
  let seen: any
  const ok = await runWebSearch(config, prompt, { fetchImpl: async (url, init) => {
    seen = { url, init }
    return new Response(JSON.stringify({ data: { web: [{ title: '北京', url: 'https://x.com', description: '中国首都是北京' }] } }), { status: 200 })
  } })
  assert.equal(ok.ok, true)
  assert.equal(ok.query, '中国的首都是哪个城市')
  assert.match(ok.text, /\[1\] 北京/)
  assert.equal(seen.url, 'https://api.firecrawl.dev/v2/search')
  assert.equal(JSON.parse(seen.init.body).query, '中国的首都是哪个城市')

  const unauthorized = await runWebSearch(config, prompt, { fetchImpl: async () => new Response(JSON.stringify({ error: 'Unauthorized: Invalid token' }), { status: 401 }) })
  assert.equal(unauthorized.ok, false)
  assert.match(unauthorized.text, /^错误: Firecrawl 返回 401.*API Key.*Invalid token/)
  const noCredit = await runWebSearch({ ...config, provider: 'exa' }, prompt, { fetchImpl: async () => new Response('{"error":"credits"}', { status: 402 }) })
  assert.match(noCredit.text, /^错误: Exa 返回 402.*额度/)
  assert.match((await runWebSearch(config, prompt, { fetchImpl: async () => new Response('{"data":{"web":[]}}', { status: 200 }) })).text, /没有搜到/)
  assert.match((await runWebSearch(config, prompt, { fetchImpl: async () => new Response('<html>', { status: 200 }) })).text, /不是 JSON/)
  assert.match((await runWebSearch(config, prompt, { fetchImpl: async () => { throw new Error('connection refused') } })).text, /connection refused/)
  assert.match((await runWebSearch({ ...config, apiKey: '' }, prompt)).text, /API Key/)
  assert.match((await runWebSearch(config, '【题目】\n  \n\n请作答')).text, /题目内容为空/)

  const waitForAbort = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  const slow = await runWebSearch({ ...config, timeoutSec: 0.05 }, prompt, { fetchImpl: waitForAbort })
  assert.equal(slow.ok, false)
  assert.match(slow.text, /搜索超时/)
  const controller = new AbortController()
  const cancelled = runWebSearch({ ...config, timeoutSec: 30 }, prompt, { signal: controller.signal, fetchImpl: waitForAbort })
  controller.abort()
  assert.match((await cancelled).text, /已取消/)
})
test('web search: answers only count as different when the final answers differ', async () => {
  const { extractComparableAnswer, answersDisagree, buildSearchContextBlock } = await import('../src/services/webSearch')
  const reply = (answer: string, thought = '先分析一下…') => `${thought}\n{"answer": "${answer}"}`
  assert.equal(extractComparableAnswer(reply('B. 传动角')), '传动角')
  assert.equal(extractComparableAnswer('```json\n{"answer":"Meeting."}\n```'), 'meeting')
  assert.equal(extractComparableAnswer('思考\n最终：正确'), '最终正确')
  assert.equal(answersDisagree([reply('传动角', '理由甲'), reply('B. 传动角', '理由乙完全不同')]), false)
  assert.equal(answersDisagree([reply('传动角'), reply('压力角')]), true)
  assert.equal(answersDisagree([reply('传动角')]), false)
  assert.equal(answersDisagree(['', reply('传动角')]), false)
  assert.equal(answersDisagree([]), false)
  assert.match(buildSearchContextBlock('[1] x'), /最终答案里不要出现链接和来源[\s\S]*\[1\] x$/)
})
test('web search: judgement answers with different wording are not a disagreement', async () => {
  const { extractComparableAnswer, answersDisagree } = await import('../src/services/webSearch')
  const reply = (answer: string) => `分析过程\n{"answer": "${answer}"}`
  const yes = ['正确', '对', '是', '真', '对的', '正确。', 'A. 正确', ' 对 ', '√', '✓', '✔', 'true', 'True', 'TRUE', 'T', 'Yes', 'right', 'correct', '答案：对', '答案是对', '最终答案：正确', '对。', '正确！', '（对）'.replace(/[（）]/g, '')]
  const no = ['错误', '错', '否', '假', '不对', '不正确', '不是', '错误。', 'B. 错误', '×', '✗', '✘', 'false', 'False', 'F', 'No', 'wrong', 'incorrect', '答案：错', '答案是错误', '错。', '错误！']
  for (const a of yes) assert.equal(extractComparableAnswer(reply(a)), 'judge:true', `true: ${a}`)
  for (const a of no) assert.equal(extractComparableAnswer(reply(a)), 'judge:false', `false: ${a}`)
  // every pair of "yes" wordings agrees, every pair of "no" wordings agrees, yes vs no disagrees
  assert.equal(answersDisagree(yes.map(reply)), false)
  assert.equal(answersDisagree(no.map(reply)), false)
  for (const a of yes) for (const b of no) assert.equal(answersDisagree([reply(a), reply(b)]), true, `${a} vs ${b}`)
  // "答案：是" is just "是", not an empty answer
  assert.equal(extractComparableAnswer(reply('答案：是')), 'judge:true')
  // an answer that is not JSON at all: the last line still counts
  assert.equal(answersDisagree(['想了想\n答案：对', reply('正确'), '最终答案是：正确。']), false)
  assert.equal(answersDisagree(['想了想\n答案：对', reply('错误')]), true)
})
test('web search: answer comparison ignores order, width, case, punctuation and option letters', async () => {
  const { extractComparableAnswer, answersDisagree } = await import('../src/services/webSearch')
  const reply = (answer: string) => `思考\n{"answer": "${answer}"}`
  // multiple choice: option order does not matter
  assert.equal(answersDisagree([reply('甲#乙#丙'), reply('丙#甲#乙')]), false)
  assert.equal(answersDisagree([reply('甲#乙'), reply('甲#乙#丙')]), true)
  // full-width characters, case and punctuation
  assert.equal(answersDisagree([reply('ＡＢＣ　ｄｅ'), reply('abc de')]), false)
  assert.equal(answersDisagree([reply('Meeting.'), reply('meeting')]), false)
  assert.equal(answersDisagree([reply('3.14'), reply('3.14。')]), false)
  assert.equal(answersDisagree([reply('3.14'), reply('3.15')]), true)
  // option letters in front, in any width
  assert.equal(answersDisagree([reply('C．传动角'), reply('C. 传动角'), reply('传动角')]), false)
  assert.equal(answersDisagree([reply('A. 传动角'), reply('B. 压力角')]), true)
  // a real answer that merely starts with a judgement word is kept whole
  assert.notEqual(extractComparableAnswer(reply('是非曲直')), 'judge:true')
  assert.notEqual(extractComparableAnswer(reply('对数函数')), 'judge:true')
  assert.equal(answersDisagree([reply('对数函数'), reply('指数函数')]), true)
})
