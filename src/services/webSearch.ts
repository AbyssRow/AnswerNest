// 总结时联网搜索：直接调用 Firecrawl / Exa / DeepSeek 的搜索接口，把结果整理成一段文字放进总结模型的上下文。
// 搜索只在总结阶段做一次（不是每个模型一次），失败不影响答题，只是没有搜索资料。
import { validateProxyUrl } from './providerTransport'

export type WebSearchProvider = 'firecrawl' | 'exa' | 'deepseek'
export type ExaSearchType = 'lite' | 'auto' | 'fast' | 'instant' | 'deep-lite' | 'deep' | 'deep-reasoning'
export type ExaContentMode = 'highlights' | 'text'
export type DeepSeekContentMode = 'summary' | 'content'
export type SearchOptionsMode = 'never' | 'auto' | 'always'

/** auto 模式下，题目不足这么多字就补上选项 */
export const SHORT_TITLE_CHARS = 12
/** DeepSeek 的 query 最多 128 个字符（site: 等搜索语法也写在 query 里） */
export const DEEPSEEK_MAX_QUERY_CHARS = 128

export interface WebSearchConnection {
  apiKey: string
  baseUrl: string
  proxyUrl: string
}

export interface WebSearchConfig {
  enabled: boolean
  provider: WebSearchProvider
  apiKey: string
  /** 留空用官方地址；自建 Firecrawl 或中转可以填 */
  baseUrl: string
  maxResults: number
  /** 每条结果最多保留多少字 */
  maxCharsPerResult: number
  /** 整个搜索最多等多久（秒），超时就不带搜索资料继续总结 */
  timeoutSec: number
  /** 搜索词最多多少字 */
  maxQueryChars: number
  /** 搜索词要不要带选项：never 只搜题目；auto 题目太短（不足 shortTitleChars 字）才补选项；always 总是带 */
  optionsMode: SearchOptionsMode
  /** 逗号或换行分隔的域名，例如 baidu.com, zhihu.com */
  includeDomains: string
  excludeDomains: string
  proxyUrl: string
  /** 各搜索服务独立的连接配置；顶层字段保留给当前服务和旧版配置兼容。 */
  providerSettings?: Partial<Record<WebSearchProvider, WebSearchConnection>>
  exaType: ExaSearchType
  exaContent: ExaContentMode
  /** Firecrawl：是否抓取网页正文（更准但每条多耗积分）；关闭则只用搜索结果自带的摘要 */
  firecrawlScrape: boolean
  /** DeepSeek：summary 只用接口给模型准备的摘要（约 600–800 字）；content 额外请求网页正文 */
  deepseekContent: DeepSeekContentMode
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  enabled: false,
  provider: 'firecrawl',
  apiKey: '',
  baseUrl: '',
  maxResults: 3,
  maxCharsPerResult: 2000,
  timeoutSec: 20,
  maxQueryChars: 300,
  optionsMode: 'auto',
  includeDomains: '',
  excludeDomains: '',
  proxyUrl: '',
  providerSettings: {},
  exaType: 'auto',
  exaContent: 'highlights',
  firecrawlScrape: true,
  deepseekContent: 'summary'
}

export const WEB_SEARCH_PROVIDERS: { id: WebSearchProvider; name: string; baseUrl: string; keyUrl: string }[] = [
  { id: 'firecrawl', name: 'Firecrawl', baseUrl: 'https://api.firecrawl.dev', keyUrl: 'https://www.firecrawl.dev/app/api-keys' },
  { id: 'exa', name: 'Exa', baseUrl: 'https://api.exa.ai', keyUrl: 'https://dashboard.exa.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys' }
]

const providerName = (provider: WebSearchProvider) => WEB_SEARCH_PROVIDERS.find(p => p.id === provider)!.name

/** 搜索模式与计费说明核对于 2026-10-25：https://exa.ai/docs/reference/search / https://exa.ai/pricing */
export const EXA_SEARCH_MODES: { id: ExaSearchType; label: string; description: string }[] = [
  { id: 'lite', label: 'lite · 经济快速', description: '低成本、低延迟，适合日常题目核对。每 1000 次搜索 4 美元（每次最多 10 条结果）；使用定期更新的索引，不在搜索时实时抓取网页。' },
  { id: 'auto', label: 'auto · 均衡（默认）', description: '兼顾质量与速度，在检索和排序上投入更多计算。每 1000 次搜索 7 美元（每次最多 10 条结果）。' },
  { id: 'deep-lite', label: 'deep-lite · 轻量研究', description: '对搜索结果进一步研究并综合资料，耗时比普通检索更长。可按需要增加搜索超时。' },
  { id: 'deep', label: 'deep · 深度研究', description: '进行多步检索与综合，适合复杂问题。每 1000 次搜索 12 美元（每次最多 10 条结果）；需要预留更长的搜索和总结时间。' },
  { id: 'fast', label: 'fast · 旧版快速', description: '保留旧配置兼容；Exa 官方现建议使用 lite。' },
  { id: 'instant', label: 'instant · 旧版极速', description: '保留旧配置兼容；Exa 官方现建议使用 lite。' },
  { id: 'deep-reasoning', label: 'deep-reasoning · 旧版深度推理', description: '保留旧配置兼容；Exa 官方现建议使用 deep。' }
]

export const EXA_SEARCH_TYPES: ExaSearchType[] = EXA_SEARCH_MODES.map(mode => mode.id)

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** 设置文件里可能缺字段、类型不对：补默认值并限制范围 */
export function normalizeWebSearchConfig(input?: Partial<WebSearchConfig> | null): WebSearchConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<WebSearchConfig>
  const d = DEFAULT_WEB_SEARCH_CONFIG
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
  const provider = raw.provider === 'exa' || raw.provider === 'deepseek' ? raw.provider : 'firecrawl'
  const providerSettings: Partial<Record<WebSearchProvider, WebSearchConnection>> = {}
  for (const { id } of WEB_SEARCH_PROVIDERS) {
    const saved = raw.providerSettings?.[id]
    providerSettings[id] = {
      apiKey: str(saved?.apiKey, '').trim(),
      baseUrl: str(saved?.baseUrl, '').trim(),
      proxyUrl: str(saved?.proxyUrl, '').trim()
    }
  }
  // 旧配置只迁移到原来选中的服务；当前编辑的字段优先，包括主动清空的值。
  const connection = providerSettings[provider]!
  connection.apiKey = str(raw.apiKey, connection.apiKey).trim()
  connection.baseUrl = str(raw.baseUrl, connection.baseUrl).trim()
  connection.proxyUrl = str(raw.proxyUrl, connection.proxyUrl).trim()
  return {
    enabled: raw.enabled === true,
    provider,
    ...connection,
    providerSettings,
    maxResults: clampInt(raw.maxResults, 1, 10, d.maxResults),
    maxCharsPerResult: clampInt(raw.maxCharsPerResult, 200, 10000, d.maxCharsPerResult),
    timeoutSec: clampInt(raw.timeoutSec, 3, 120, d.timeoutSec),
    maxQueryChars: clampInt(raw.maxQueryChars, 20, 500, d.maxQueryChars),
    optionsMode: raw.optionsMode ==='never' || raw.optionsMode === 'always' ? raw.optionsMode : 'auto',
    includeDomains: str(raw.includeDomains, d.includeDomains),
    excludeDomains: str(raw.excludeDomains, d.excludeDomains),
    exaType: EXA_SEARCH_TYPES.includes(raw.exaType as ExaSearchType) ? raw.exaType as ExaSearchType : d.exaType,
    exaContent: raw.exaContent === 'text' ? 'text' : 'highlights',
    firecrawlScrape: raw.firecrawlScrape !== false,
    deepseekContent: raw.deepseekContent === 'content' ? 'content' : 'summary'
  }
}

/** 先保存当前服务，再恢复目标服务，避免将其它服务的密钥发送给它。 */
export function switchWebSearchProvider(config: WebSearchConfig, provider: WebSearchProvider): WebSearchConfig {
  const current = normalizeWebSearchConfig(config)
  return normalizeWebSearchConfig({ ...current, provider, ...current.providerSettings![provider]! })
}

export function webSearchReady(config: WebSearchConfig): boolean {
  return config.enabled && !!config.apiKey
}

export interface SearchResultItem {
  title: string
  url: string
  content: string
}

/** 逗号、分号、空格、换行分隔的域名，去掉协议和路径 */
export function parseDomainList(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[\s,;，；]+/)) {
    const domain = part.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
    if (domain) seen.add(domain)
  }
  return [...seen]
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * 从发给答题模型的提示词里取出题目和选项。
 * 提示词格式：…【题目】\n标题\n【选项】\n选项…\n\n请作答…；不是这个格式时用整段文字。
 */
export function extractQuestionParts(prompt: string): { title: string; options: string } {
  const titleMark = prompt.indexOf('【题目】')
  if (titleMark < 0) return { title: collapse(prompt), options: '' }
  const afterTitle = prompt.slice(titleMark + '【题目】'.length)
  const optionsMark = afterTitle.indexOf('【选项】')
  const endMark = afterTitle.search(/\n\s*请作答/)
  const titleEnd = optionsMark >= 0 ? optionsMark : (endMark >= 0 ? endMark : afterTitle.length)
  const title = collapse(afterTitle.slice(0, titleEnd))
  let options = ''
  if (optionsMark >= 0) {
    const rest = afterTitle.slice(optionsMark + '【选项】'.length)
    const restEnd = rest.search(/\n\s*请作答/)
    options = collapse(restEnd >= 0 ? rest.slice(0, restEnd) : rest)
  }
  return { title, options }
}

/** 去掉对搜索没用的东西：【单选题】、开头的题号、填空的下划线和空括号 */
export function cleanQuestionText(text: string): string {
  return collapse(
    text
      .replace(/^\s*[【\[（(]\s*[^】\]）)]{0,12}题\s*[】\]）)]/, '')
      .replace(/^\s*\d{1,3}\s*[.、．)）]\s*/, '')
      .replace(/[_＿—]{2,}/g, ' ')
      .replace(/[（(]\s*[）)]/g, ' ')
  )
}

/** 搜索词：题目，按 optionsMode 决定是否带选项，压成一行并截断。题目是空的返回空串，调用方应跳过搜索。 */
export function buildSearchQuery(prompt: string, config: Pick<WebSearchConfig, 'optionsMode' | 'maxQueryChars'>): string {
  const parts = extractQuestionParts(prompt)
  const title = cleanQuestionText(parts.title)
  if (!title) return ''
  const withOptions = !!parts.options && (config.optionsMode === 'always' || (config.optionsMode === 'auto' && title.length < SHORT_TITLE_CHARS))
  const text = withOptions ? `${title} ${parts.options}` : title
  return text.length > config.maxQueryChars ? text.slice(0, config.maxQueryChars) : text
}

const trimSlash = (value: string) => value.replace(/\/+$/, '')

function resolveBaseUrl(config: WebSearchConfig): string {
  const fallback = WEB_SEARCH_PROVIDERS.find(p => p.id === config.provider)!.baseUrl
  const base = trimSlash(config.baseUrl || fallback)
  let url: URL
  try { url = new URL(base) } catch { throw new Error('搜索服务地址不是完整 URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('搜索服务地址必须使用 HTTP 或 HTTPS')
  return base
}

export interface SearchHttpRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

export function buildFirecrawlRequest(config: WebSearchConfig, query: string): SearchHttpRequest {
  const body: Record<string, unknown> = {
    query,
    limit: config.maxResults,
    sources: ['web'],
    timeout: config.timeoutSec * 1000
  }
  const include = parseDomainList(config.includeDomains)
  const exclude = parseDomainList(config.excludeDomains)
  // Firecrawl 的两个域名过滤互斥，同时填了优先用「只搜这些」
  if (include.length) body.includeDomains = include
  else if (exclude.length) body.excludeDomains = exclude
  if (config.firecrawlScrape) body.scrapeOptions = { formats: [{ type: 'markdown' }], onlyMainContent: true }
  return {
    url: `${resolveBaseUrl(config)}/v2/search`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body
  }
}

export function buildExaRequest(config: WebSearchConfig, query: string): SearchHttpRequest {
  const body: Record<string, unknown> = {
    query,
    type: config.exaType,
    numResults: config.maxResults,
    contents: config.exaContent === 'text'
      ? { text: { maxCharacters: config.maxCharsPerResult } }
      // 摘录只能到 10000 字
      : { highlights: { maxCharacters: Math.min(config.maxCharsPerResult, 10000) } }
  }
  const include = parseDomainList(config.includeDomains)
  const exclude = parseDomainList(config.excludeDomains)
  if (include.length) body.includeDomains = include
  if (exclude.length) body.excludeDomains = exclude
  return {
    url: `${resolveBaseUrl(config)}/search`,
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
    body
  }
}

/** 按 Unicode 字符截断，不会切开表情这类两个码元的字符 */
const takeChars = (text: string, max: number): string => {
  const chars = Array.from(text)
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : text
}

export function buildDeepSeekRequest(config: WebSearchConfig, query: string): SearchHttpRequest {
  // DeepSeek 没有域名过滤参数，改用搜索语法写进 query：多个 site: 用 OR 连接，多个 -site: 用空格分隔
  const include = parseDomainList(config.includeDomains).map(d => `site:${d}`).join(' OR ')
  const exclude = parseDomainList(config.excludeDomains).map(d => `-site:${d}`).join(' ')
  const filters = [include, exclude].filter(Boolean).join(' ')
  const room = DEEPSEEK_MAX_QUERY_CHARS - Array.from(filters).length - 1
  // 域名太多会把题目挤没，这时宁可不过滤
  const text = filters && room >= 20 ? `${takeChars(query, room)} ${filters}` : takeChars(query, DEEPSEEK_MAX_QUERY_CHARS)
  const body: Record<string, unknown> = { query: text, count: config.maxResults }
  if (config.deepseekContent === 'content') body.need_content = true
  return {
    url: `${resolveBaseUrl(config)}/v1/tools/search`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body
  }
}

export function buildSearchRequest(config: WebSearchConfig, query: string): SearchHttpRequest {
  if (config.provider === 'exa') return buildExaRequest(config, query)
  if (config.provider === 'deepseek') return buildDeepSeekRequest(config, query)
  return buildFirecrawlRequest(config, query)
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean
}

export function parseFirecrawlResponse(json: any, maxChars: number): SearchResultItem[] {
  const data = json?.data
  // v2 返回 { data: { web: [...] } }，旧版返回 { data: [...] }
  const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.web) ? data.web : []
  return list.map(item => ({
    title: collapse(asString(item?.title)),
    url: asString(item?.url),
    content: clip(asString(item?.markdown) || asString(item?.description), maxChars)
  })).filter(item => item.content || item.title)
}

export function parseExaResponse(json: any, maxChars: number): SearchResultItem[] {
  const list: any[] = Array.isArray(json?.results) ? json.results : []
  return list.map(item => {
    const highlights = Array.isArray(item?.highlights) ? item.highlights.filter((h: unknown) => typeof h === 'string').join('\n…\n') : ''
    return {
      title: collapse(asString(item?.title)),
      url: asString(item?.url),
      content: clip(asString(item?.text) || highlights || asString(item?.summary), maxChars)
    }
  }).filter(item => item.content || item.title)
}

export function parseDeepSeekResponse(json: any, maxChars: number): SearchResultItem[] {
  const list: any[] = Array.isArray(json?.results) ? json.results : []
  return list.map(item => ({
    title: collapse(asString(item?.title)),
    url: asString(item?.url),
    // 没要正文时 content 是空串，用给模型准备的 summary；再没有才用给页面展示的 snippet
    content: clip(asString(item?.content) || asString(item?.summary) || asString(item?.snippet), maxChars)
  })).filter(item => item.content || item.title)
}

export function parseSearchResponse(provider: WebSearchProvider, json: unknown, maxChars: number): SearchResultItem[] {
  if (provider === 'exa') return parseExaResponse(json, maxChars)
  if (provider === 'deepseek') return parseDeepSeekResponse(json, maxChars)
  return parseFirecrawlResponse(json, maxChars)
}

/** 从服务返回里取一句能看懂的错误 */
export function searchErrorMessage(status: number, bodyText: string, provider: WebSearchProvider): string {
  let detail = ''
  try {
    const json = JSON.parse(bodyText)
    detail = asString(json?.error) || asString(json?.message) || asString(json?.error?.message)
  } catch { detail = bodyText.slice(0, 200) }
  detail = collapse(detail).slice(0, 200)
  const name = providerName(provider)
  const hint = status === 401 || status === 403 ? '（检查 API Key 是否正确）'
    : status === 402 ? (provider === 'deepseek' ? '（账户余额不足）' : '（额度或积分不足）')
    : status === 429 ? (provider === 'deepseek' ? '（超过每秒 5 次的搜索频率限制）' : '（请求太频繁或额度用完）')
    : ''
  return `${name} 返回 ${status}${hint}${detail ? '：' + detail : ''}`
}

/** 整理成放进总结提示词里的文字，同一份也显示在日志里 */
export function formatSearchContext(items: SearchResultItem[]): string {
  return items.map((item, index) => {
    const head = `[${index + 1}] ${item.title || '（无标题）'}${item.url ? `\n${item.url}` : ''}`
    return item.content ? `${head}\n${item.content}` : head
  }).join('\n\n')
}

export interface WebSearchOutcome {
  ok: boolean
  items: SearchResultItem[]
  /** 给日志看的文字：成功是整理后的搜索结果，失败是「错误: …」 */
  text: string
  query: string
  tookMs: number
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

async function defaultFetch(config: WebSearchConfig): Promise<FetchLike> {
  const proxyUrl = validateProxyUrl(config.proxyUrl)
  const { fetch: nativeFetch } = await import('@tauri-apps/plugin-http')
  return (input, init) => nativeFetch(input, { ...init, ...(proxyUrl ? { proxy: { all: proxyUrl } } : {}) } as any)
}

/** 执行一次搜索。出错不抛异常，返回 ok:false 和可读的错误文字 */
export async function runWebSearch(
  config: WebSearchConfig,
  prompt: string,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}
): Promise<WebSearchOutcome> {
  const started = Date.now()
  const query = buildSearchQuery(prompt, config.provider === 'deepseek'
    ? { ...config, maxQueryChars: Math.min(config.maxQueryChars, DEEPSEEK_MAX_QUERY_CHARS) }
    : config)
  const fail = (message: string): WebSearchOutcome =>
    ({ ok: false, items: [], text: `错误: ${message}`, query, tookMs: Date.now() - started })
  if (!query) return fail('题目内容为空，已跳过搜索')
  if (!config.apiKey) return fail('没有填写搜索服务的 API Key')
  if (options.signal?.aborted) return fail('搜索已取消')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutSec * 1000)
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort)
  try {
    const request = buildSearchRequest(config, query)
    const send = options.fetchImpl ?? await defaultFetch(config)
    if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError')
    const response = await send(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    })
    const bodyText = await response.text()
    if (!response.ok) return fail(searchErrorMessage(response.status, bodyText, config.provider))
    let json: unknown
    try { json = JSON.parse(bodyText) } catch { return fail('搜索服务返回的不是 JSON') }
    const items = parseSearchResponse(config.provider, json, config.maxCharsPerResult).slice(0, config.maxResults)
    if (!items.length) return fail('没有搜到相关结果')
    return { ok: true, items, text: formatSearchContext(items), query, tookMs: Date.now() - started }
  } catch (error) {
    if (controller.signal.aborted) {
      return fail(options.signal?.aborted ? '搜索已取消' : `搜索超时（${config.timeoutSec} 秒）`)
    }
    return fail(error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}

export { extractComparableAnswer, answersDisagree } from '../utils/answerConsensus'

/** 总结提示词里搜索资料那一段 */
export function buildSearchContextBlock(text: string): string {
  return `联网搜索资料（仅供核对，以原题为准）：\n${text}`
}
