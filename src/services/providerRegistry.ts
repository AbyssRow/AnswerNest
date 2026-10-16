import type { AIModel } from './modelConfig'

/** 标准 API：自定义提供商只需要说明它兼容哪一种 */
export type ApiStyle = 'openai-chat' | 'openai-response' | 'anthropic'

/**
 * 上游异步 Batch API 的规范：
 * - openai：OpenAI 文件式（上传 JSONL → /batches），OpenAI、百炼、Groq 等兼容
 * - anthropic：Message Batches
 * - mistral：batch/jobs
 * - openrouter：POST /batches 直接带 requests，结果在查询响应里
 * null 表示没有、或没有公开可核实的规范
 */
export type BatchSpec = 'openai' | 'anthropic' | 'mistral' | 'openrouter' | null

export type ProviderGroup = 'international' | 'china' | 'gateway' | 'local'

export interface ProviderDef {
  id: string
  name: string
  baseUrl: string
  /** 新建模型时默认选的 API 协议 */
  apiStyle: ApiStyle
  /** 参数适配（思考开关、采样参数等的方言）；没有特殊方言用 compatible */
  upstream: NonNullable<AIModel['upstream']>
  batch: BatchSpec
  group: ProviderGroup
  /** 本地服务不需要 API Key */
  noKey?: boolean
  /** 申请 API Key 的页面 */
  keyUrl?: string
}

export const providerGroupLabels: Record<ProviderGroup, string> = {
  international: '国际',
  china: '国内',
  gateway: '聚合网关',
  local: '本地',
}

// 只收录官方 API Key 接入点。地区或网关前缀可在添加后的「高级设置」里改。
export const providers: ProviderDef[] = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiStyle: 'openai-chat', upstream: 'openai', batch: 'openai', group: 'international', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiStyle: 'anthropic', upstream: 'compatible', batch: 'anthropic', group: 'international', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiStyle: 'openai-chat', upstream: 'gemini', batch: null, group: 'international', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiStyle: 'openai-chat', upstream: 'mistral', batch: 'mistral', group: 'international', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', apiStyle: 'openai-chat', upstream: 'xai', batch: null, group: 'international', keyUrl: 'https://console.x.ai' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiStyle: 'openai-chat', upstream: 'groq', batch: 'openai', group: 'international', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiStyle: 'openai-chat', upstream: 'deepseek', batch: null, group: 'china', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'qwen', name: '通义百炼（北京）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiStyle: 'openai-chat', upstream: 'qwen', batch: 'openai', group: 'china', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1' },
  { id: 'moonshot', name: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiStyle: 'openai-chat', upstream: 'moonshot', batch: null, group: 'china', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiStyle: 'openai-chat', upstream: 'zhipu', batch: null, group: 'china', keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { id: 'volcengine', name: '火山方舟（北京）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiStyle: 'openai-chat', upstream: 'volcengine', batch: null, group: 'china', keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', apiStyle: 'openai-chat', upstream: 'siliconflow', batch: null, group: 'china', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiStyle: 'openai-chat', upstream: 'openrouter', batch: 'openrouter', group: 'gateway', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.ai/v1', apiStyle: 'openai-chat', upstream: 'compatible', batch: null, group: 'international' },
  { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1', apiStyle: 'openai-chat', upstream: 'compatible', batch: null, group: 'international' },
  { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', apiStyle: 'openai-chat', upstream: 'compatible', batch: null, group: 'international' },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', apiStyle: 'openai-chat', upstream: 'compatible', batch: null, group: 'international' },
  { id: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', apiStyle: 'openai-chat', upstream: 'compatible', batch: null, group: 'local', noKey: true },
  { id: 'lmstudio', name: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', apiStyle: 'openai-chat', upstream: 'compatible', batch: null, group: 'local', noKey: true },
]

/** 自定义提供商可选的标准 API */
export const customApiStyles: { value: ApiStyle; label: string; endpoint: string; batch: BatchSpec }[] = [
  { value: 'openai-chat', label: 'OpenAI Chat Completions 兼容', endpoint: '/v1/chat/completions', batch: null },
  { value: 'openai-response', label: 'OpenAI Responses 兼容', endpoint: '/v1/responses', batch: null },
  { value: 'anthropic', label: 'Anthropic Messages 兼容', endpoint: '/v1/messages', batch: null },
]

export const CUSTOM_PROVIDER_ID = 'custom'

export function findProvider(id?: string): ProviderDef | undefined {
  return providers.find(provider => provider.id === id)
}

/** 老平台没有 provider 字段时，按地址推断是哪家 */
export function inferProviderFromUrl(baseUrl?: string): ProviderDef | undefined {
  try {
    const host = new URL(baseUrl || '').hostname
    return providers.find(provider => new URL(provider.baseUrl).hostname === host)
  } catch {
    return undefined
  }
}

/**
 * 平台使用的提供商定义。
 * 已经记录了 provider（包括 'custom'）就以它为准，不再按地址猜：用户明确选了「自定义」，
 * 即使地址恰好是某家官方域名，也不能偷偷套用那家的 Batch 或参数方言。
 * 只有没有 provider 字段的老平台才按地址推断。
 */
export function providerForPlatform(platform: { provider?: string; baseUrl?: string }): ProviderDef | undefined {
  if (platform.provider) return findProvider(platform.provider)
  return inferProviderFromUrl(platform.baseUrl)
}

/** 平台的 Batch 规范；自定义提供商默认没有（避免对不确定的接口乱发请求） */
export function batchSpecForPlatform(platform: { provider?: string; baseUrl?: string }): BatchSpec {
  return providerForPlatform(platform)?.batch ?? null
}

/** 新建模型时的默认 API 协议 */
export function defaultProtocolForPlatform(platform: { provider?: string; apiStyle?: ApiStyle; baseUrl?: string }): ApiStyle {
  return platform.apiStyle ?? providerForPlatform(platform)?.apiStyle ?? 'openai-chat'
}
