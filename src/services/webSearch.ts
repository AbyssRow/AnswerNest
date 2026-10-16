// 总结时联网搜索：直接调用 Firecrawl / Exa 的搜索接口，把结果整理成一段文字放进总结模型的上下文。
// 搜索只在总结阶段做一次（不是每个模型一次），失败不影响答题，只是没有搜索资料。
import { validateProxyUrl } from './providerTransport'

export type WebSearchProvider = 'firecrawl' | 'exa'
export type ExaSearchType = 'auto' | 'fast' | 'instant' | 'deep-lite' | 'deep'
export type ExaContentMode = 'highlights' | 'text'
export type SearchOptionsMode = 'never' | 'auto' | 'always'

/** auto 模式下，题目不足这么多字就补上选项 */
export const SHORT_TITLE_CHARS = 12

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
  /** 只在答题模型的答案不一致时才搜索（省额度；答案一致说明题不难）。搜索要等答题结束后才开始，会多等一会儿 */
  onlyWhenDisagree: boolean
  /** 搜索词要不要带选项：never 只搜题目；auto 题目太短（不足 shortTitleChars 字）才补选项；always 总是带 */
  optionsMode: SearchOptionsMode
  /** 逗号或换行分隔的域名，例如 baidu.com, zhihu.com */
  includeDomains: string
  excludeDomains: string
  proxyUrl: string
  exaType: ExaSearchType
  exaContent: ExaContentMode
  /** Firecrawl：是否抓取网页正文（更准但每条多耗积分）；关闭则只用搜索结果自带的摘要 */
  firecrawlScrape: boolean
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
  onlyWhenDisagree: false,
  optionsMode: 'auto',
  includeDomains: '',
  excludeDomains: '',
  proxyUrl: '',
  exaType: 'auto',
  exaContent: 'highlights',
  firecrawlScrape: true
}

export const WEB_SEARCH_PROVIDERS: { id: WebSearchProvider; name: string; baseUrl: string; keyUrl: string }[] = [
  { id: 'firecrawl', name: 'Firecrawl', baseUrl: 'https://api.firecrawl.dev', keyUrl: 'https://www.firecrawl.dev/app/api-keys' },
  { id: 'exa', name: 'Exa', baseUrl: 'https://api.exa.ai', keyUrl: 'https://dashboard.exa.ai/api-keys' }
]

export const EXA_SEARCH_TYPES: ExaSearchType[] = ['auto', 'fast', 'instant', 'deep-lite', 'deep']

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** 设置文件里可能缺字段、类型不对：补默认值并限制范围 */
export function normalizeWebSearchConfig(input?: Partial<WebSearchConfig> | null): WebSearchConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<WebSearchConfig>
  const d = DEFAULT_WEB_SEARCH_CONFIG
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
  return {
    enabled: raw.enabled === true,
    provider: raw.provider === 'exa' ? 'exa' : 'firecrawl',
    apiKey: str(raw.apiKey, d.apiKey).trim(),
    baseUrl: str(raw.baseUrl, d.baseUrl).trim(),
    maxResults: clampInt(raw.maxResults, 1, 10, d.maxResults),
    maxCharsPerResult: clampInt(raw.maxCharsPerResult, 200, 10000, d.maxCharsPerResult),
    timeoutSec: clampInt(raw.timeoutSec, 3, 120, d.timeoutSec),
    maxQueryChars: clampInt(raw.maxQueryChars, 20, 500, d.maxQueryChars),
    onlyWhenDisagree: raw.onlyWhenDisagree === true,
    optionsMode: raw.optionsMode ==='never' || raw.optionsMode === 'always' ? raw.optionsMode : 'auto',
    includeDomains: str(raw.includeDomains, d.includeDomains),
    excludeDomains: str(raw.excludeDomains, d.excludeDomains),
    proxyUrl: str(raw.proxyUrl, d.proxyUrl).trim(),
    exaType: EXA_SEARCH_TYPES.includes(raw.exaType as ExaSearchType) ? raw.exaType as ExaSearchType : d.exaType,
    exaContent: raw.exaContent === 'text' ? 'text' : 'highlights',
    firecrawlScrape: raw.firecrawlScrape !== false
  }
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

export function buildSearchRequest(config: WebSearchConfig, query: string): SearchHttpRequest {
  return config.provider === 'exa' ? buildExaRequest(config, query) : buildFirecrawlRequest(config, query)
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

/** 从服务返回里取一句能看懂的错误 */
export function searchErrorMessage(status: number, bodyText: string, provider: WebSearchProvider): string {
  let detail = ''
  try {
    const json = JSON.parse(bodyText)
    detail = asString(json?.error) || asString(json?.message) || asString(json?.error?.message)
  } catch { detail = bodyText.slice(0, 200) }
  detail = collapse(detail).slice(0, 200)
  const name = provider === 'exa' ? 'Exa' : 'Firecrawl'
  const hint = status === 401 || status === 403 ? '（检查 API Key 是否正确）'
    : status === 402 ? '（额度或积分不足）'
    : status === 429 ? '（请求太频繁或额度用完）'
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
  const query = buildSearchQuery(prompt, config)
  const fail = (message: string): WebSearchOutcome =>
    ({ ok: false, items: [], text: `错误: ${message}`, query, tookMs: Date.now() - started })
  if (!query) return fail('题目内容为空，已跳过搜索')
  if (!config.apiKey) return fail('没有填写搜索服务的 API Key')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutSec * 1000)
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort)
  try {
    const request = buildSearchRequest(config, query)
    const send = options.fetchImpl ?? await defaultFetch(config)
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
    const items = config.provider === 'exa'
      ? parseExaResponse(json, config.maxCharsPerResult)
      : parseFirecrawlResponse(json, config.maxCharsPerResult)
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

/**
 * 取出一个模型回答里「最终答案」部分用来比较：优先取最后一个 {"answer": "…"}，没有就取最后一行。
 * 去掉空白、标点、选项字母前缀（A. / B、）并转小写，所以 "B. 传动角" 和 "传动角" 算同一个答案。
 */
export function extractComparableAnswer(response: string): string {
  const text = (response || '').replace(/```[a-z]*\n?|```/gi, '')
  let answer = ''
  for (const match of text.matchAll(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) answer = match[1]
  if (!answer) {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
    answer = lines[lines.length - 1] || ''
  }
  return answer
    .replace(/\\n/g, ' ')
    .replace(/^\s*[A-Za-z][.、．:：)）]\s*/, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

/** 至少两个有内容的回答，并且最终答案不全相同 */
export function answersDisagree(responses: string[]): boolean {
  const answers = responses.map(extractComparableAnswer).filter(Boolean)
  return answers.length >= 2 && new Set(answers).size > 1
}

/** 总结提示词里搜索资料那一段 */
export function buildSearchContextBlock(text: string): string {
  return `联网搜索资料（仅供核对答案参考，可能与题目无关或有误，以题目本身和各模型的回答为准；最终答案里不要出现链接和来源）：\n${text}`
}
