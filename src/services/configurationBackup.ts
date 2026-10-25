import type { AppSettings } from './settings'
import type { ModelSettings } from './modelConfig'
import { normalizeWebSearchConfig } from './webSearch'
import { normalizeModelNames } from '../utils/modelIdentity'

export const CONFIGURATION_FORMAT = 'answernest-configuration'
export const CONFIGURATION_MAX_BYTES = 10 * 1024 * 1024

// 这些值依赖本机屏幕或题库，跨设备迁移时保留目标机器上的值。
const portableKeys = [
  'theme', 'language', 'autoSave', 'closeToTray', 'autoAddToQuestionBank',
  'modelResponseTimeout', 'modelRetryCount', 'webSearch', 'defaultDifficulty',
  'itemsPerPage', 'showExplanation', 'network', 'enableNotifications',
  'suppressNoModelWarning', 'algorithms', 'adminToken', 'multiUser'
] as const
type PortableSettings = Pick<AppSettings, typeof portableKeys[number]>

export interface ConfigurationBackup {
  format: typeof CONFIGURATION_FORMAT
  version: 1
  appVersion: string
  exportedAt: string
  settings: Partial<PortableSettings>
  models: ModelSettings
}

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const fail = (field: string): never => { throw new Error(`配置文件中的「${field}」格式不正确`) }
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string')

function fields(value: Record<string, any>, names: string[], type: 'string' | 'boolean' | 'number', path: string) {
  for (const key of names) {
    if (value[key] !== undefined && (typeof value[key] !== type || (type === 'number' && !Number.isFinite(value[key])))) fail(`${path}.${key}`)
  }
}

function portableSettings(input: unknown): Partial<PortableSettings> {
  if (!object(input)) fail('常规设置')
  const settings = Object.fromEntries(portableKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]]))
  fields(settings, ['autoSave', 'closeToTray', 'autoAddToQuestionBank', 'showExplanation', 'enableNotifications', 'suppressNoModelWarning'], 'boolean', '常规设置')
  fields(settings, ['modelResponseTimeout', 'modelRetryCount', 'itemsPerPage'], 'number', '常规设置')
  fields(settings, ['adminToken'], 'string', '常规设置')
  for (const [key, allowed] of Object.entries({ theme: ['light', 'dark', 'auto'], language: ['zh-CN', 'en-US'], defaultDifficulty: ['easy', 'medium', 'hard'] })) {
    if (settings[key] !== undefined && !allowed.includes(settings[key])) fail(key)
  }
  for (const [key, min, max] of [['modelResponseTimeout', 5, 600], ['modelRetryCount', 0, 10], ['itemsPerPage', 1, 10000]] as const) {
    if (settings[key] !== undefined && (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max)) fail(key)
  }
  if (settings.network !== undefined) {
    const network = settings.network
    if (!object(network) || !Number.isInteger(network.serverPort) || network.serverPort < 1 || network.serverPort > 65535 || typeof network.enableLanAccess !== 'boolean') fail('网络设置')
    settings.network = { serverPort: network.serverPort, enableLanAccess: network.enableLanAccess, bindAddress: network.enableLanAccess ? '0.0.0.0' : '127.0.0.1' }
  }
  if (settings.webSearch !== undefined) {
    if (!object(settings.webSearch)) fail('搜索设置')
    if (settings.webSearch.provider !== undefined && !['firecrawl', 'exa', 'deepseek'].includes(settings.webSearch.provider)) fail('搜索服务')
    fields(settings.webSearch, ['apiKey', 'baseUrl', 'proxyUrl', 'includeDomains', 'excludeDomains'], 'string', '搜索设置')
    fields(settings.webSearch, ['enabled', 'firecrawlScrape'], 'boolean', '搜索设置')
    if (settings.webSearch.providerSettings !== undefined) {
      if (!object(settings.webSearch.providerSettings)) fail('搜索服务连接')
      for (const connection of Object.values(settings.webSearch.providerSettings)) {
        if (!object(connection)) fail('搜索服务连接')
        fields(connection, ['apiKey', 'baseUrl', 'proxyUrl'], 'string', '搜索服务连接')
      }
    }
    settings.webSearch = normalizeWebSearchConfig(settings.webSearch)
  }
  if (settings.algorithms !== undefined && (!Array.isArray(settings.algorithms) || settings.algorithms.some(a => !object(a) || ['id', 'name', 'applicableType', 'code'].some(key => typeof a[key] !== 'string')))) fail('算法设置')
  if (settings.multiUser !== undefined) {
    const users = settings.multiUser
    if (!object(users) || typeof users.enabled !== 'boolean' || !Array.isArray(users.users) || users.users.some(user => !object(user) || ['id', 'name', 'token', 'createdAt'].some(key => typeof user[key] !== 'string'))) fail('多用户设置')
  }
  return settings
}

function validateModels(value: unknown): asserts value is ModelSettings {
  if (!object(value) || !Array.isArray(value.platforms) || !object(value.globalSettings)) return fail('模型设置')
  fields(value.globalSettings, ['timeout', 'retryCount'], 'number', '模型全局设置')
  fields(value.globalSettings, ['enableLogging'], 'boolean', '模型全局设置')
  const platformIds = new Set<string>()
  const modelIds = new Set<string>()
  for (const platform of value.platforms) {
    if (!object(platform) || typeof platform.id !== 'string' || !platform.id.trim() || typeof platform.name !== 'string' || !platform.name.trim() || !Array.isArray(platform.models)) fail('平台')
    if (platformIds.has(platform.id)) fail('重复的平台 ID')
    platformIds.add(platform.id)
    fields(platform, ['displayName', 'baseUrl', 'apiKey', 'proxyUrl', 'provider', 'apiStyle'], 'string', '平台')
    fields(platform, ['enabled', 'isRemote'], 'boolean', '平台')
    if (platform.customHeaders !== undefined && (!object(platform.customHeaders) || Object.values(platform.customHeaders).some(value => typeof value !== 'string'))) fail('平台请求头')
    for (const model of platform.models) {
      if (!object(model)) fail('模型')
      Object.assign(model, normalizeModelNames(model))
      if (typeof model.id !== 'string' || !model.id.trim() || typeof model.name !== 'string' || !model.name.trim()) fail('模型')
      if (modelIds.has(model.id)) fail('重复的模型 ID')
      modelIds.add(model.id)
      fields(model, ['modelId', 'displayName', 'platformId', 'jsCode', 'description', 'apiProtocol', 'upstream', 'thinkingMode', 'thinkingEffort', 'thinkingOffResponsesEffort'], 'string', '模型')
      fields(model, ['maxTokens', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty', 'seed', 'thinkingBudget'], 'number', '模型')
      fields(model, ['enabled', 'supportsVision', 'enableThinking', 'isRemote', 'thinkingOffEnableThinkingFalse', 'thinkingOffThinkingTypeDisabled', 'thinkingOffEffortNone', 'thinkingOffReasoningEffortNone'], 'boolean', '模型')
      if (model.apiProtocol !== undefined && !['openai-chat', 'openai-response', 'anthropic', 'decision', 'custom'].includes(model.apiProtocol)) fail('模型协议')
      if (model.category !== undefined && !['text', 'vision', 'summary'].includes(model.category)) fail('模型分类')
      for (const key of ['stop', 'omitParameters']) if (model[key] !== undefined && !strings(model[key])) fail(`模型.${key}`)
      if (model.extraBody !== undefined && !object(model.extraBody)) fail('模型高级参数')
    }
  }
  for (const key of ['selectedTextModels', 'selectedSummaryModels', 'deletedPredefinedPlatforms', 'deletedPredefinedModels']) {
    if (value[key] !== undefined && !strings(value[key])) fail(key)
  }
  for (const key of ['selectedTextModel', 'selectedSummaryModel', 'selectedVisionModel']) {
    if (value[key] != null && typeof value[key] !== 'string') fail(key)
  }
}

export function parseConfigurationBackup(text: string): ConfigurationBackup {
  if (new TextEncoder().encode(text).byteLength > CONFIGURATION_MAX_BYTES) throw new Error('配置文件不能超过 10 MB')
  let value: any
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''), (key, value) => {
      if (key === '__proto__') fail('对象字段')
      return value
    })
  } catch { throw new Error('无法读取配置文件，请选择 AnswerNest 导出的 JSON 配置文件') }
  if (!object(value) || value.format !== CONFIGURATION_FORMAT) throw new Error('这不是 AnswerNest 完整配置文件，请使用「导出配置」生成的文件')
  if (value.version !== 1) throw new Error('暂不支持此配置文件版本，请更新 AnswerNest 后重试')
  const settings = portableSettings(value.settings)
  validateModels(value.models)
  return { format: CONFIGURATION_FORMAT, version: 1, appVersion: typeof value.appVersion === 'string' ? value.appVersion : '', exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '', settings, models: value.models }
}

export function createConfigurationBackup(settings: AppSettings, models: ModelSettings, appVersion: string): string {
  const backup = { format: CONFIGURATION_FORMAT, version: 1, appVersion, exportedAt: new Date().toISOString(), settings, models }
  return JSON.stringify(parseConfigurationBackup(JSON.stringify(backup)), null, 2)
}

async function managers() {
  const [{ settingsManager }, { modelConfigManager }] = await Promise.all([import('./settings'), import('./modelConfig')])
  await Promise.all([settingsManager.ready(), modelConfigManager.ready()])
  return { settingsManager, modelConfigManager }
}

export async function exportConfiguration(appVersion: string): Promise<string> {
  const { settingsManager, modelConfigManager } = await managers()
  return createConfigurationBackup(settingsManager.getSettings(), modelConfigManager.getSettings(), appVersion)
}

export async function importConfiguration(backup: ConfigurationBackup): Promise<void> {
  // 再次校验，避免调用方绕过文件预览直接导入不合法的数据。
  const next = parseConfigurationBackup(JSON.stringify(backup))
  const { settingsManager, modelConfigManager } = await managers()
  const previousSettings = settingsManager.export()
  const previousModels = modelConfigManager.export()
  try {
    modelConfigManager.import(JSON.stringify(next.models))
    settingsManager.import(JSON.stringify(next.settings))
    const results = await Promise.allSettled([modelConfigManager.save(), settingsManager.save()])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  } catch {
    modelConfigManager.import(previousModels)
    settingsManager.import(previousSettings)
    const rollback = await Promise.allSettled([modelConfigManager.save(), settingsManager.save()])
    if (rollback.some(result => result.status === 'rejected')) throw new Error('导入保存失败，原配置未能全部恢复到磁盘；请保留配置文件，检查磁盘后重试')
    throw new Error('配置导入失败，已恢复原配置；请检查磁盘空间和写入权限后重试')
  }
}
