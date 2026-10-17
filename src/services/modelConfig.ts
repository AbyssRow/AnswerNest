import { reactive, watch, computed } from 'vue'
import { normalizeApiProtocol } from './modelProtocol'
import { inferSupportsVision, modelSupportsVision } from '../utils/questionAttachments'
import { adoptRemotePlatforms } from './remoteCatalogMigration'

// AI 平台配置接口
export interface AIPlatform {
  id: string
  name: string
  displayName: string
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: AIModel[]
  customHeaders?: Record<string, string>
  proxyUrl?: string // 空值沿用系统代理；支持 HTTP(S)/SOCKS5(H)
  provider?: string // providerRegistry 里的提供商 id；'custom' 表示自定义（走标准 API）
  apiStyle?: 'openai-chat' | 'openai-response' | 'anthropic' // 自定义提供商兼容的标准 API
  description?: string
  icon?: string        // 平台图标
  isRemote?: boolean   // 是否来自远程同步（禁止编辑/删除）
  url?: string         // 平台官网/控制台地址
  inviteUrl?: string   // 邀请链接
  inviteText?: string  // 邀请文字
  inviteCode?: string  // 邀请码
}

// AI 模型配置接口
/** 开启思考时的强度：Chat 用 reasoning_effort，Responses/Messages 用 reasoning.effort */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max'
/** Responses 关闭思考时 reasoning.effort 取值 */
export type ThinkingOffResponsesEffort = 'none' | 'minimal'

export interface AIModel {
  id: string
  modelId?: string
  name: string
  displayName: string
  platformId: string
  maxTokens: number
  temperature: number
  topP: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  stop?: string[]
  topK?: number
  thinkingBudget?: number
  upstream?: 'auto' | 'openai' | 'deepseek' | 'qwen' | 'gemini' | 'openrouter' | 'groq' | 'mistral' | 'xai' | 'moonshot' | 'zhipu' | 'volcengine' | 'siliconflow' | 'compatible'
  thinkingMode?: 'auto' | 'budget' | 'adaptive'
  extraBody?: Record<string, unknown>
  omitParameters?: string[]
  enabled: boolean
  category: 'text' | 'vision' | 'summary'  // 角色只用 text；旧的 vision 在读取时并入视觉开关
  supportsVision?: boolean  // 能看图。在模型设置里开，不再单独占一类
  description?: string
  jsCode?: string  // 仅自定义协议使用；远程模型忽略此字段
  icon?: string    // 模型图标
  isRemote?: boolean  // 是否来自远程同步（禁止编辑/删除）
  enableThinking?: boolean  // 是否启用思考（reasoning）输出
  /** Chat 关闭：发送 enable_thinking: false（默认 true） */
  thinkingOffEnableThinkingFalse?: boolean
  /** @deprecated 已由 thinkingOffResponsesEffort 替代 */
  thinkingOffEffortNone?: boolean
  /** Chat / Messages 关闭：发送 thinking: { type: "disabled" } */
  thinkingOffThinkingTypeDisabled?: boolean
  /** @deprecated Chat 不再用 reasoning_effort 关闭 */
  thinkingOffReasoningEffortNone?: boolean
  /** Responses 关闭：reasoning.effort = none | minimal（默认 minimal） */
  thinkingOffResponsesEffort?: ThinkingOffResponsesEffort
  /** 开启思考时的强度（默认 medium） */
  thinkingEffort?: ThinkingEffort
  apiProtocol?: 'openai-chat' | 'openai-response' | 'anthropic' | 'decision' | 'custom'
}

// 模型配置设置接口
export interface ModelSettings {
  selectedTextModel: string | null    // 选中的文本模型（向后兼容，等于 selectedTextModels[0] 或 null）
  selectedTextModels: string[]        // 选中的文本模型列表（最多5个）
  selectedSummaryModel: string | null // 选中的总结模型（向后兼容，等于 selectedSummaryModels[0] 或 null）
  selectedSummaryModels: string[]     // 选中的总结模型列表（最多5个）
  selectedVisionModel: string | null  // 选中的视觉模型
  platforms: AIPlatform[]
  globalSettings: {
    timeout: number
    retryCount: number
    enableLogging: boolean
  }
  // 记录用户删除的预设平台和模型，用于后续启动不再恢复（已废弃，保留兼容）
  deletedPredefinedPlatforms?: string[]
  deletedPredefinedModels?: string[]
}

const USER_CREATED_PLATFORM_ID_PREFIX = 'custom_'
const LEGACY_USER_CREATED_MODEL_ID_PREFIX = 'model_'

const isLikelyUserCreatedPlatform = (platform: Pick<AIPlatform, 'id'>): boolean => {
  return typeof platform.id === 'string' && platform.id.startsWith(USER_CREATED_PLATFORM_ID_PREFIX)
}

const isLikelyUserCreatedModel = (model: Pick<AIModel, 'id' | 'platformId'>, platformId?: string): boolean => {
  if (!model?.id) return false
  if (model.id.startsWith(LEGACY_USER_CREATED_MODEL_ID_PREFIX)) return true

  const resolvedPlatformId = platformId || model.platformId
  return !!resolvedPlatformId && model.id.startsWith(`${resolvedPlatformId}_`) && /_\d+$/.test(model.id)
}

const dedupeModelsById = (models: AIModel[]): AIModel[] => {
  const modelMap = new Map<string, AIModel>()

  for (const model of models) {
    if (!model?.id) continue

    const existing = modelMap.get(model.id)
    if (!existing || (!!model.isRemote && !existing.isRemote)) {
      modelMap.set(model.id, model)
    }
  }

  return [...modelMap.values()]
}

const getPlatformApiKey = (platforms: AIPlatform[], preferredPlatform?: AIPlatform): string => {
  if (preferredPlatform?.apiKey?.trim()) {
    return preferredPlatform.apiKey
  }

  return platforms.find(platform => platform.apiKey?.trim())?.apiKey || ''
}

const migrateStoredModel = (model: AIModel): AIModel => {
  const wasVision = model.category === 'vision'
  const next: AIModel = wasVision || model.category === 'summary'
    ? { ...model, category: 'text' }
    : model
  if (wasVision) next.supportsVision = true
  else if (next.supportsVision === undefined && inferSupportsVision(next)) next.supportsVision = true
  return next
}

const sanitizeStoredPlatforms = (platforms: AIPlatform[]): AIPlatform[] => {
  const groupedPlatforms = new Map<string, AIPlatform[]>()

  for (const platform of platforms) {
    if (!platform?.id || !platform.name?.trim()) continue

    const existingPlatforms = groupedPlatforms.get(platform.id)
    if (existingPlatforms) {
      existingPlatforms.push(platform)
    } else {
      groupedPlatforms.set(platform.id, [platform])
    }
  }

  return [...groupedPlatforms.values()].map((sameIdPlatforms) => {
    const hasRemoteDuplicate = sameIdPlatforms.some(platform => platform.isRemote)
    const preferredPlatform = sameIdPlatforms.find(platform => platform.isRemote)
      ?? sameIdPlatforms.find(platform => isLikelyUserCreatedPlatform(platform))
      ?? sameIdPlatforms[0]

    const models = dedupeModelsById(
      sameIdPlatforms.flatMap(platform => (platform.models || [])
        .filter((model): model is AIModel => !!model?.id)
        .filter((model) => {
          if (!hasRemoteDuplicate) return true
          if (model.isRemote) return true
          return isLikelyUserCreatedModel(model, platform.id)
        })
        .map(model => {
          const nextModel: AIModel = {
            ...model,
            platformId: preferredPlatform.id,
            isRemote: model.isRemote === true,
          }
          // 远程模型不再保留 jsCode
          if (nextModel.isRemote) {
            delete nextModel.jsCode
          }
          return migrateStoredModel(nextModel)
        })
      )
    )

    return {
      ...preferredPlatform,
      displayName: preferredPlatform.displayName || preferredPlatform.name || preferredPlatform.id,
      apiKey: getPlatformApiKey(sameIdPlatforms, preferredPlatform),
      models,
    }
  })
}

// 默认模型配置（没有预置平台：用户在「添加平台」里选提供商，数据只存在本地）
const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  selectedTextModel: null,
  selectedTextModels: [],
  selectedSummaryModel: null,
  selectedSummaryModels: [],
  selectedVisionModel: null,
  platforms: [],
  globalSettings: {
    timeout: 30000,
    retryCount: 3,
    enableLogging: false
  },
  deletedPredefinedPlatforms: [],
  deletedPredefinedModels: []
}

// 模型配置存储键
const MODEL_SETTINGS_STORAGE_KEY = 'model_settings'
const freshModelDefaults = (): ModelSettings => JSON.parse(JSON.stringify(DEFAULT_MODEL_SETTINGS))

/**
 * 模型配置管理器类
 */
class ModelConfigManager {
  private settings: ModelSettings
  private listeners: Set<(settings: ModelSettings) => void> = new Set()
  private shouldPersistLoadedSettings = false
  // localStorage 为空（全新安装，或更名/换 identifier 后 WebView 数据目录变了）时，
  // 尝试从 model_config.json 恢复。恢复完成前不能把空配置写回该文件，否则会覆盖唯一的副本。
  private restoringFromFile = false
  private needsFileRestore = true
  private pendingFileSave: Promise<void> = Promise.resolve()

  constructor() {
    this.settings = reactive(this.loadSettings())
    this.normalizeSelectedModels()
    if (this.shouldPersistLoadedSettings) {
      this.saveSettings()
    }
    this.setupAutoSave()
    if (this.needsFileRestore) {
      this.restoringFromFile = true
      void this.restoreFromFile().finally(() => {
        this.restoringFromFile = false
      })
    }
  }

  /**
   * 解析已保存的配置：过滤无名平台并清理旧字段。
   */
  private parseStoredSettings(parsedSettings: any): { settings: ModelSettings; changed: boolean } {
    if (!parsedSettings || !Array.isArray(parsedSettings.platforms)) throw new Error('配置格式无效')
    const loadedSettings: ModelSettings = {
      ...freshModelDefaults(),
      ...parsedSettings,
      globalSettings: { ...DEFAULT_MODEL_SETTINGS.globalSettings, ...parsedSettings.globalSettings },
      platforms: parsedSettings.platforms.filter((p: AIPlatform) => typeof p?.name === 'string' && p.name.trim()),
      selectedTextModels: Array.isArray(parsedSettings.selectedTextModels) ? parsedSettings.selectedTextModels : [],
      selectedSummaryModels: Array.isArray(parsedSettings.selectedSummaryModels) ? parsedSettings.selectedSummaryModels : [],
    }
    const sanitizedSettings: ModelSettings = {
      ...loadedSettings,
      platforms: sanitizeStoredPlatforms(loadedSettings.platforms || []),
    }
    // 早期版本同步下来的「远程平台」转成普通本地平台（见 remoteCatalogMigration.ts）
    const adopted = adoptRemotePlatforms(sanitizedSettings.platforms)
    sanitizedSettings.platforms = adopted.platforms
    return {
      settings: sanitizedSettings,
      changed: adopted.changed || JSON.stringify(loadedSettings) !== JSON.stringify(sanitizedSettings),
    }
  }

  /**
   * 从用户数据目录的 model_config.json 恢复模型配置（localStorage 为空或损坏时调用）
   */
  private async restoreFromFile(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content = await invoke<string>('read_model_config')
      if (!content?.trim()) return
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed?.platforms)) return
      const { settings } = this.parseStoredSettings(parsed)
      Object.assign(this.settings, settings)
      this.normalizeSelectedModels()
      console.log('已从 model_config.json 恢复模型配置')
    } catch (error) {
      // 非 Tauri 环境、文件不存在或内容损坏：保持默认配置
      console.warn('从 model_config.json 恢复模型配置失败:', error)
    }
  }

  /**
   * 从本地存储加载模型配置
   */
  private loadSettings(): ModelSettings {
    try {
      const stored = localStorage.getItem(MODEL_SETTINGS_STORAGE_KEY)
      if (stored) {
        const { settings, changed } = this.parseStoredSettings(JSON.parse(stored))
        this.shouldPersistLoadedSettings = changed
        this.needsFileRestore = false
        return settings
      }
    } catch (error) {
      console.warn('加载模型配置失败，使用默认配置:', error)
    }
    return freshModelDefaults()
  }

  private dedupeAndFilterModelIds(modelIds: Array<string | null | undefined>, validIds: Set<string>, maxCount: number): string[] {
    const uniqueIds: string[] = []

    for (const modelId of modelIds) {
      if (!modelId || !validIds.has(modelId) || uniqueIds.includes(modelId)) {
        continue
      }

      uniqueIds.push(modelId)
      if (uniqueIds.length >= maxCount) {
        break
      }
    }

    return uniqueIds
  }

  private autoDetectEnableThinking(): void {
    for (const platform of this.settings.platforms) {
      for (const model of platform.models || []) {
        // 用户已明确设置过（true/false）则不再覆盖，避免“关闭思考”被启动/同步逻辑改回开启
        if (typeof model.enableThinking === 'boolean') continue

        const id = (model.id || '').toLowerCase()
        const name = ((model.name || '') + (model.displayName || '')).toLowerCase()
        const isKnownThinking =
          id.includes('reasoner') || name.includes('reasoner') ||
          id.includes('-r1') || name.includes('-r1') ||
          id.includes('thinking') || name.includes('thinking') ||
          id.includes('deepseek-r1') || name.includes('deepseek r1') ||
          id.startsWith('o1') || id.startsWith('o3')
        if (isKnownThinking) {
          model.enableThinking = true
        }
      }
    }
  }

  private normalizeSelectedModels(): void {
    this.autoDetectEnableThinking()
    const enabledPlatforms = this.settings.platforms.filter(platform => platform.enabled !== false)
    const allModels = enabledPlatforms.flatMap(platform => platform.models || [])
    const enabledModels = allModels.filter(model => model.enabled !== false)
    if (this.settings.selectedVisionModel) {
      this.settings.selectedTextModels = [
        this.settings.selectedVisionModel,
        ...(this.settings.selectedTextModels || [])
      ]
      this.settings.selectedVisionModel = null
    }

    const textModelIds = new Set(enabledModels.filter(model => model.category !== 'summary').map(model => model.id))
    const summaryModelIds = new Set(enabledModels.filter(model => modelSupportsVision(model)).map(model => model.id))

    const normalizedTextModels = this.dedupeAndFilterModelIds(
      [
        ...(this.settings.selectedTextModels || []),
        ...(this.settings.selectedTextModel ? [this.settings.selectedTextModel] : [])
      ],
      textModelIds,
      5
    )

    const normalizedSummaryModels = this.dedupeAndFilterModelIds(
      [
        ...(this.settings.selectedSummaryModels || []),
        ...(this.settings.selectedSummaryModel ? [this.settings.selectedSummaryModel] : [])
      ],
      summaryModelIds,
      1
    )

    this.settings.selectedTextModels = normalizedTextModels
    this.settings.selectedTextModel = normalizedTextModels[0] || null
    this.settings.selectedSummaryModels = normalizedSummaryModels
    this.settings.selectedSummaryModel = normalizedSummaryModels[0] || null
    this.settings.selectedVisionModel = null
  }

  private clearSelectedModelsForPlatform(platformId: string): void {
    const platform = this.settings.platforms.find(item => item.id === platformId)
    if (!platform) return

    const platformModelIds = new Set((platform.models || []).map(model => model.id))

    if (this.settings.selectedTextModels) {
      this.settings.selectedTextModels = this.settings.selectedTextModels.filter(id => !platformModelIds.has(id))
      this.settings.selectedTextModel = this.settings.selectedTextModels[0] || null
    }

    if (this.settings.selectedSummaryModels) {
      this.settings.selectedSummaryModels = this.settings.selectedSummaryModels.filter(id => !platformModelIds.has(id))
      this.settings.selectedSummaryModel = this.settings.selectedSummaryModels[0] || null
    }

    if (this.settings.selectedVisionModel && platformModelIds.has(this.settings.selectedVisionModel)) {
      this.settings.selectedVisionModel = null
    }
  }

   /**
   * 当某个模型被删除/消失时，若它被选中，替换为同平台同类型的另一个可用模型
   */
  private _replaceSelectedModel(
    modelId: string,
    category: string,
    platformId: string,
    candidateModels?: AIModel[]
  ): void {
    const findReplacement = (): AIModel | undefined => {
      const pool = candidateModels
        ?? this.settings.platforms.find(p => p.id === platformId)?.models ?? []
      return pool.find(m => m.id !== modelId && m.category === category && m.enabled !== false)
    }

    if (category === 'text') {
      if (this.settings.selectedTextModels?.includes(modelId)) {
        const replacement = findReplacement()
        this.settings.selectedTextModels = this.settings.selectedTextModels.filter(id => id !== modelId)
        if (replacement && !this.settings.selectedTextModels.includes(replacement.id)) {
          this.settings.selectedTextModels.push(replacement.id)
        }
        this.settings.selectedTextModel = this.settings.selectedTextModels[0] || null
      }
    } else if (category === 'summary') {
      if (this.settings.selectedSummaryModels?.includes(modelId)) {
        const replacement = findReplacement()
        this.settings.selectedSummaryModels = this.settings.selectedSummaryModels.filter(id => id !== modelId)
        if (replacement && !this.settings.selectedSummaryModels.includes(replacement.id)) {
          this.settings.selectedSummaryModels.push(replacement.id)
        }
        this.settings.selectedSummaryModel = this.settings.selectedSummaryModels[0] || null
      }
    } else if (category === 'vision') {
      if (this.settings.selectedVisionModel === modelId) {
        const replacement = findReplacement()
        this.settings.selectedVisionModel = replacement?.id || null
      }
    }
  }

  /**
   * 保存配置到本地存储，并异步写入文件
   */
  private saveSettings(): void {
    try {
      localStorage.setItem(MODEL_SETTINGS_STORAGE_KEY, JSON.stringify(this.settings))
      this.notifyListeners()
      // 异步写入 model_config.json
      this.saveToFile()
    } catch (error) {
      console.error('保存模型配置失败:', error)
      throw new Error('模型配置保存失败')
    }
  }

  /**
   * 异步写入 model_config.json
   */
  private async saveToFile(): Promise<void> {
    if (this.restoringFromFile) return
    const content = JSON.stringify(this.settings)
    try {
      this.pendingFileSave = this.pendingFileSave.catch(() => {}).then(async () => {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('write_model_config', { content })
      })
      await this.pendingFileSave
    } catch {
      // 非 Tauri 环境忽略
    }
  }

  /**
   * 设置自动保存
   */
  private setupAutoSave(): void {
    watch(
      () => this.settings,
      () => {
        this.saveSettings()
      },
      { deep: true }
    )
  }

  /**
   * 通知监听器配置已更改
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.settings)
      } catch (error) {
        console.error('模型配置监听器执行失败:', error)
      }
    })
  }

  /**
   * 获取当前配置
   */
  getSettings(): ModelSettings {
    return this.settings
  }

  /**
   * 获取所有平台
   */
  getPlatforms(): AIPlatform[] {
    return this.settings.platforms
  }

  /**
   * 获取启用的平台
   */
  getEnabledPlatforms(): AIPlatform[] {
    // 平台必须启用，且有启用的模型才返回
    return this.settings.platforms.filter(p => 
      p.enabled && 
      p.models && 
      p.models.some(model => model.enabled)
    )
  }

  /**
   * 获取所有可用模型
   */
  getAvailableModels(): AIModel[] {
    return this.getEnabledPlatforms()
      .flatMap(platform => platform.models)
      .filter(model => model.enabled)
  }

  /**
   * 获取当前选中的文本模型（向后兼容，返回第一个选中模型）
   */
  getSelectedTextModel(): AIModel | null {
    // 优先从新字段 [0] 获取
    if (this.settings.selectedTextModels && this.settings.selectedTextModels.length > 0) {
      const allModels = this.settings.platforms.flatMap(p => p.models)
      return allModels.find(m => m.id === this.settings.selectedTextModels[0] && m.category === 'text') || null
    }
    // 兜底从旧字段获取
    if (this.settings.selectedTextModel) {
      const allModels = this.settings.platforms.flatMap(p => p.models)
      return allModels.find(m => m.id === this.settings.selectedTextModel && m.category === 'text') || null
    }
    return null
  }

  /**
   * 获取所有选中的文本模型
   */
  getSelectedTextModels(): AIModel[] {
    // 如果新字段有数据，直接返回
    if (this.settings.selectedTextModels && this.settings.selectedTextModels.length > 0) {
      const allModels = this.settings.platforms.flatMap(p => p.models)
      return this.settings.selectedTextModels
        .map(id => allModels.find(m => m.id === id && m.category === 'text'))
        .filter((m): m is AIModel => m !== undefined)
    }
    // 如果新字段为空但旧字段有值，尝试转换
    const legacyModel = this.getSelectedTextModel()
    return legacyModel ? [legacyModel] : []
  }

  /**
   * 切换文本模型选中状态（最多5个）
   */
  toggleSelectedTextModel(modelId: string): void {
    this.normalizeSelectedModels()
    if (!this.settings.selectedTextModels) this.settings.selectedTextModels = []
    const idx = this.settings.selectedTextModels.indexOf(modelId)
    if (idx !== -1) {
      this.settings.selectedTextModels.splice(idx, 1)
    } else {
      if (this.settings.selectedTextModels.length >= 5) return
      this.settings.selectedTextModels.push(modelId)
    }
    this.settings.selectedTextModel = this.settings.selectedTextModels[0] || null
  }

  /**
   * 判断文本模型是否被选中
   */
  isTextModelSelected(modelId: string): boolean {
    if (!this.settings.selectedTextModels) return false
    return this.settings.selectedTextModels.includes(modelId)
  }

  /**
   * 获取当前选中的总结模型（向后兼容，返回第一个选中模型）
   */
  getSelectedSummaryModel(): AIModel | null {
    // 优先从新字段 [0] 获取
    if (this.settings.selectedSummaryModels && this.settings.selectedSummaryModels.length > 0) {
      const allModels = this.settings.platforms.flatMap(p => p.models)
      return allModels.find(m => m.id === this.settings.selectedSummaryModels[0]) || null
    }
    // 兜底从旧字段获取
    if (this.settings.selectedSummaryModel) {
      const allModels = this.settings.platforms.flatMap(p => p.models)
      return allModels.find(m => m.id === this.settings.selectedSummaryModel) || null
    }
    return null
  }

  /**
   * 获取所有选中的总结模型
   */
  getSelectedSummaryModels(): AIModel[] {
    // 如果新字段有数据，直接返回
    if (this.settings.selectedSummaryModels && this.settings.selectedSummaryModels.length > 0) {
      const allModels = this.settings.platforms.flatMap(p => p.models)
      return this.settings.selectedSummaryModels
        .map(id => allModels.find(m => m.id === id))
        .filter((m): m is AIModel => m !== undefined)
    }
    // 如果新字段为空但旧字段有值，尝试转换
    const legacyModel = this.getSelectedSummaryModel()
    return legacyModel ? [legacyModel] : []
  }

  /**
   * 切换总结模型选中状态（最多5个）
   */
  toggleSelectedSummaryModel(modelId: string): void {
    if (!this.settings.selectedSummaryModels) this.settings.selectedSummaryModels = []
    
    const isSelected = this.settings.selectedSummaryModels.includes(modelId)
    if (!isSelected) {
      const model = this.settings.platforms.flatMap(p => p.models).find(m => m.id === modelId)
      if (!modelSupportsVision(model)) return
    }

    if (isSelected) {
      // 如果已经选中，则取消全部选中
      this.settings.selectedSummaryModels = []
      this.settings.selectedSummaryModel = null
    } else {
      // 如果未选中，则清除之前的选择，仅选中当前这一个
      this.settings.selectedSummaryModels = [modelId]
      this.settings.selectedSummaryModel = modelId
    }
  }

  /**
   * 判断总结模型是否被选中
   */
  isSummaryModelSelected(modelId: string): boolean {
    if (!this.settings.selectedSummaryModels) return false
    return this.settings.selectedSummaryModels.includes(modelId)
  }

  /**
   * 获取当前选中的视觉模型
   */
  getSelectedVisionModel(): AIModel | null {
    if (!this.settings.selectedVisionModel) return null
    
    const allModels = this.settings.platforms.flatMap(p => p.models)
    return allModels.find(m => m.id === this.settings.selectedVisionModel && m.category === 'vision') || null
  }

  /**
   * 获取当前选中的模型（文本模型或视觉模型）
   */
  getSelectedModel(): AIModel | null {
    // 优先返回总结模型，然后文本模型，如果没有则返回视觉模型
    const summaryModel = this.getSelectedSummaryModel()
    if (summaryModel) {
      return summaryModel
    }
    const textModel = this.getSelectedTextModel()
    if (textModel) {
      return textModel
    }
    return this.getSelectedVisionModel()
  }

  /**
   * 设置选中的文本模型（向后兼容，替换整个选中列表为单个模型）
   */
  setSelectedTextModel(modelId: string | null): void {
    this.settings.selectedTextModel = modelId
    this.settings.selectedTextModels = modelId ? [modelId] : []
  }

  /**
   * 设置选中的总结模型
   */
  setSelectedSummaryModel(modelId: string | null): void {
    this.settings.selectedSummaryModel = modelId
    this.settings.selectedSummaryModels = modelId ? [modelId] : []
  }

  /**
   * 设置选中的视觉模型
   */
  setSelectedVisionModel(modelId: string | null): void {
    this.settings.selectedVisionModel = modelId
    // 移除互斥逻辑，允许同时选择文本和视觉模型
  }

  /**
   * 切换视觉模型选中状态（再点一次取消选择）
   */
  toggleSelectedVisionModel(modelId: string): void {
    if (this.settings.selectedVisionModel === modelId) {
      this.settings.selectedVisionModel = null
    } else {
      this.settings.selectedVisionModel = modelId
    }
  }

  /**
   * 判断视觉模型是否被选中
   */
  isVisionModelSelected(modelId: string): boolean {
    return this.settings.selectedVisionModel === modelId
  }

  /**
   * 设置选中的模型（兼容旧接口，设置文本模型）
   */
  setSelectedModel(modelId: string | null): void {
    this.setSelectedTextModel(modelId)
  }

  /**
   * 添加自定义平台
   */
  addPlatform(platform: Omit<AIPlatform, 'id'>): string {
    const id = `custom_${Date.now()}`
    const newPlatform: AIPlatform = {
      ...platform,
      id,
      displayName: platform.name,
      enabled: platform.enabled ?? true,
      isRemote: false,
      models: platform.models || []
    }

    this.settings.platforms.push(newPlatform)
    return id
  }

  /**
   * 更新平台配置
   */
  updatePlatform(platformId: string, updates: Partial<AIPlatform>): void {
    const platform = this.settings.platforms.find(p => p.id === platformId)
    if (platform) {
      const wasEnabled = platform.enabled !== false
      Object.assign(platform, updates)
      if (updates.name) {
        platform.displayName = updates.name
      }
      if (wasEnabled && platform.enabled === false) {
        this.clearSelectedModelsForPlatform(platformId)
      }
      this.normalizeSelectedModels()
    }
  }

  /**
   * 删除平台
   */
  removePlatform(platformId: string): void {
    const duplicatedPlatforms = this.settings.platforms.filter(platform => platform.id === platformId)
    if (!duplicatedPlatforms.length) return

    const duplicatedModelIds = new Set(duplicatedPlatforms.flatMap(platform => (platform.models || []).map(model => model.id)))

    this.settings.platforms = this.settings.platforms.filter(platform => platform.id !== platformId)
    this.settings.selectedTextModels = (this.settings.selectedTextModels || []).filter(id => !duplicatedModelIds.has(id))
    this.settings.selectedSummaryModels = (this.settings.selectedSummaryModels || []).filter(id => !duplicatedModelIds.has(id))

    if (this.settings.selectedTextModel && duplicatedModelIds.has(this.settings.selectedTextModel)) {
      this.settings.selectedTextModel = null
    }
    if (this.settings.selectedSummaryModel && duplicatedModelIds.has(this.settings.selectedSummaryModel)) {
      this.settings.selectedSummaryModel = null
    }
    if (this.settings.selectedVisionModel && duplicatedModelIds.has(this.settings.selectedVisionModel)) {
      this.settings.selectedVisionModel = null
    }

    this.normalizeSelectedModels()
  }

  /**
   * 添加自定义模型到平台
   */
  addModelToPlatform(platformId: string, model: Omit<AIModel, 'id' | 'platformId'>): string {
    const platform = this.settings.platforms.find(p => p.id === platformId)
    if (!platform) {
      throw new Error('平台不存在')
    }

    const modelId = `${platformId}_${model.name}_${Date.now()}`
    const newModel: AIModel = {
      ...model,
      id: modelId,
      platformId,
      isRemote: false,
    }

    platform.models.push(newModel)
    return modelId
  }

  /**
   * 更新模型配置
   */
  updateModel(modelId: string, updates: Partial<AIModel>): void {
    for (const platform of this.settings.platforms) {
      const model = platform.models.find(m => m.id === modelId)
      if (model) {
        Object.assign(model, updates)
        if (updates.supportsVision === false && this.settings.selectedSummaryModels?.includes(modelId)) {
          this.settings.selectedSummaryModels = []
          this.settings.selectedSummaryModel = null
        }
        this.normalizeSelectedModels()
        break
      }
    }
  }

  /**
   * 删除模型（远程模型不可删除，调用方应先检查 isRemote）
   */
  removeModel(modelId: string): void {
    for (const platform of this.settings.platforms) {
      const index = platform.models.findIndex(m => m.id === modelId)
      if (index !== -1) {
        const model = platform.models[index]
        // 替换选中状态（若被选中，自动切换到同平台同类型的另一个模型）
        this._replaceSelectedModel(modelId, model.category, platform.id)
        platform.models.splice(index, 1)
        this.normalizeSelectedModels()
        break
      }
    }
  }

  /**
   * 更新全局设置
   */
  updateGlobalSettings(updates: Partial<ModelSettings['globalSettings']>): void {
    Object.assign(this.settings.globalSettings, updates)
  }

  /**
   * 重置配置
   */
  reset(): void {
    Object.assign(this.settings, freshModelDefaults())
  }

  /**
   * 导出配置
   */
  export(): string {
    return JSON.stringify(this.settings, null, 2)
  }

  /**
   * 导入配置
   */
  import(jsonString: string): void {
    try {
      const importedSettings = JSON.parse(jsonString)
      if (this.validateSettings(importedSettings)) {
        Object.assign(this.settings, this.parseStoredSettings(importedSettings).settings)
        this.normalizeSelectedModels()
      } else {
        throw new Error('配置格式无效')
      }
    } catch (error) {
      console.error('导入配置失败:', error)
      throw new Error('配置导入失败')
    }
  }

  /**
   * 验证配置格式
   */
  private validateSettings(settings: any): boolean {
    return (
      settings !== null && typeof settings === 'object' &&
      Array.isArray(settings.platforms) &&
      settings.globalSettings !== null && typeof settings.globalSettings === 'object' &&
      !Array.isArray(settings.globalSettings)
    )
  }

  /**
   * 添加配置变更监听器
   */
  addListener(listener: (settings: ModelSettings) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 移除配置变更监听器
   */
  removeListener(listener: (settings: ModelSettings) => void): void {
    this.listeners.delete(listener)
  }
}

// 导出单例实例
export const modelConfigManager = new ModelConfigManager()

// 导出类型
export type { ModelConfigManager }

// 导出组合式函数
export function useModelConfig() {
  const settings = modelConfigManager.getSettings()
  
  return {
    settings,
    platforms: computed(() => modelConfigManager.getPlatforms()),
    selectedModel: computed(() => modelConfigManager.getSelectedModel()),
    selectedTextModel: computed(() => modelConfigManager.getSelectedTextModel()),
    selectedTextModels: computed(() => modelConfigManager.getSelectedTextModels()),
    selectedSummaryModel: computed(() => modelConfigManager.getSelectedSummaryModel()),
    selectedSummaryModels: computed(() => modelConfigManager.getSelectedSummaryModels()),
    selectedVisionModel: computed(() => modelConfigManager.getSelectedVisionModel()),
    availableModels: computed(() => modelConfigManager.getAvailableModels()),

    // 方法
    setSelectedModel: modelConfigManager.setSelectedModel.bind(modelConfigManager),
    setSelectedTextModel: modelConfigManager.setSelectedTextModel.bind(modelConfigManager),
    setSelectedSummaryModel: modelConfigManager.setSelectedSummaryModel.bind(modelConfigManager),
    setSelectedVisionModel: modelConfigManager.setSelectedVisionModel.bind(modelConfigManager),
    toggleSelectedTextModel: modelConfigManager.toggleSelectedTextModel.bind(modelConfigManager),
    toggleSelectedSummaryModel: modelConfigManager.toggleSelectedSummaryModel.bind(modelConfigManager),
    toggleSelectedVisionModel: modelConfigManager.toggleSelectedVisionModel.bind(modelConfigManager),
    isTextModelSelected: modelConfigManager.isTextModelSelected.bind(modelConfigManager),
    isSummaryModelSelected: modelConfigManager.isSummaryModelSelected.bind(modelConfigManager),
    isVisionModelSelected: modelConfigManager.isVisionModelSelected.bind(modelConfigManager),
    addPlatform: modelConfigManager.addPlatform.bind(modelConfigManager),
    updatePlatform: modelConfigManager.updatePlatform.bind(modelConfigManager),
    removePlatform: modelConfigManager.removePlatform.bind(modelConfigManager),
    addModelToPlatform: modelConfigManager.addModelToPlatform.bind(modelConfigManager),
    updateModel: modelConfigManager.updateModel.bind(modelConfigManager),
    removeModel: modelConfigManager.removeModel.bind(modelConfigManager),
    updateGlobalSettings: modelConfigManager.updateGlobalSettings.bind(modelConfigManager),
    
    // 工具方法
    export: modelConfigManager.export.bind(modelConfigManager),
    import: modelConfigManager.import.bind(modelConfigManager),
    reset: modelConfigManager.reset.bind(modelConfigManager),
    addListener: modelConfigManager.addListener.bind(modelConfigManager),
    removeListener: modelConfigManager.removeListener.bind(modelConfigManager)
  }
}
