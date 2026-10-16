<template>
  <div v-if="show" class="dialog-overlay" @click="handleOverlayClick">
    <div class="dialog-content" @click.stop>
      <div class="dialog-header">
        <button class="btn-back" @click="handleBack" :title="step === 'form' && !isEditing ? '重新选择提供商' : '返回'">
          <svg t="1774357412434" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="18" height="18">
            <path d="M768 96c19.2-19.2 19.2-51.2 0-70.4-19.2-19.2-51.2-19.2-70.4 0l-448 448c-19.2 19.2-19.2 51.2 0 70.4l448 448c19.2 19.2 51.2 19.2 70.4 0 19.2-19.2 19.2-51.2 0-70.4L358.4 512l409.6-416z" fill="currentColor"/>
          </svg>
        </button>
        <h3 class="dialog-title">{{ dialogTitle }}</h3>
        <button v-if="showForm" class="btn-confirm" @click="handleSubmit">完成</button>
        <span v-else class="btn-confirm-placeholder"></span>
      </div>

      <div class="dialog-body">
        <!-- 平台图标显示区域 - 顶部居中 -->
        <div v-if="showForm" class="icon-display-section">
          <div class="icon-preview-large" ref="iconPreviewRef" @click="toggleIconPicker">
            <img 
              v-if="formData.icon && !iconLoadError && isImageIcon(formData.icon)"
              :src="getIconUrl(formData.icon)"
              :alt="formData.name"
              @error="handleIconLoadError"
              class="icon-image-large"
            />
            <div 
              v-else-if="formData.icon && !isImageIcon(formData.icon)"
              class="icon-emoji-large"
            >
              {{ formData.icon }}
            </div>
            <div 
              v-else
              class="icon-fallback-large"
            >
              {{ getInitials(formData.name) }}
            </div>
            <!-- 右下角展开箭头 -->
            <div class="icon-expand-badge">
              <svg
                class="toggle-arrow"
                :class="{ 'rotated': showIconPicker }"
                width="10"
                height="10"
                viewBox="0 0 1024 1024"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M512 714.666667c-8.533333 0-17.066667-2.133333-23.466667-8.533334L146.133333 362.666667c-12.8-12.8-12.8-32 0-44.8s32-12.8 44.8 0L512 640l321.066667-322.133333c12.8-12.8 32-12.8 44.8 0s12.8 32 0 44.8L535.466667 706.133333c-6.4 6.4-14.933333 8.533333-23.466667 8.533334z" fill="currentColor"/>
              </svg>
            </div>
          </div>
          
  
          
          <!-- 图标选择器内容 -->
          <Teleport to="body">
            <div v-if="showIconPicker" ref="iconPickerRef" class="icon-picker-content" :style="pickerStyle">
              <div v-if="iconError" class="icon-error">
                {{ iconError }}
              </div>
              <div class="icon-picker">
                <div class="icon-category">
                  <h5>预设图标</h5>
                  <div class="icon-grid">
                    <div 
                      v-for="icon in availableIcons" 
                      :key="icon"
                      class="icon-option"
                      :class="{ active: formData.icon === icon }"
                      @click="selectIcon(icon)"
                    >
                      <img 
                        :src="iconUrls[icon] || getIconUrl(icon)"
                        :alt="icon"
                        @error="handleIconError(icon)"
                        class="icon-option-image"
                      />
                    </div>
                  </div>
                </div>
                <div class="icon-category">
                  <h5>Emoji图标</h5>
                  <div class="icon-grid">
                    <div 
                      v-for="emoji in emojiOptions" 
                      :key="emoji"
                      class="icon-option emoji-option"
                      :class="{ active: formData.icon === emoji }"
                      @click="selectIcon(emoji)"
                    >
                      {{ emoji }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Teleport>
        </div>

        <!-- 第一步：选择提供商（只在添加时出现） -->
        <div v-if="!showForm" class="provider-picker">
          <input v-model="providerSearch" type="search" class="form-input provider-search" placeholder="搜索提供商，例如 OpenAI、百炼、OpenRouter" />
          <button type="button" class="provider-card provider-card--custom" @click="pickCustom">
            <span class="provider-card-name">自定义提供商</span>
            <span class="provider-card-sub">任意兼容 OpenAI / Anthropic 标准 API 的服务，填地址即可</span>
          </button>
          <template v-for="group in providerGroups" :key="group.key">
            <div class="provider-group-title">{{ group.label }}</div>
            <div class="provider-grid">
              <button v-for="item in group.items" :key="item.id" type="button" class="provider-card" @click="pickProvider(item)">
                <span class="provider-card-name">{{ item.name }}</span>
              </button>
            </div>
          </template>
          <p v-if="providerGroups.length === 0" class="form-hint">没有匹配的提供商，可以选择下面的「自定义提供商」。</p>
        </div>

        <!-- 第二步：填写必要信息 -->
        <form v-else @submit.prevent="handleSubmit">
          <div v-if="!isEditing && selectedProvider" class="provider-chosen">
            <strong>{{ selectedProvider.name }}</strong>
            <span class="form-hint">{{ selectedProvider.baseUrl }}</span>
          </div>

          <!-- 自定义提供商：先说明它兼容哪种标准 API -->
          <template v-if="isCustom">
            <div class="form-group">
              <label class="form-label">平台名称</label>
              <input v-model="formData.name" type="text" class="form-input" placeholder="例如：公司内部网关" required>
            </div>
            <div class="form-group">
              <label class="form-label">兼容的标准 API</label>
              <select v-model="formData.apiStyle" class="form-input">
                <option v-for="style in customApiStyles" :key="style.value" :value="style.value">{{ style.label }}（{{ style.endpoint }}）</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">API 基础 URL</label>
              <input v-model="formData.baseUrl" type="url" class="form-input" placeholder="例如：https://gateway.example.com/v1" required>
              <p class="form-hint">只写到版本前缀即可，会自动拼接 {{ endpointHint }}；已带 /v1、/v4 等路径时原样保留。</p>
            </div>
          </template>

          <div class="form-group">
            <label class="form-label">API Key<span v-if="selectedProvider?.noKey || isEditing && currentProvider?.noKey">（本地服务可留空）</span></label>
            <input v-model="formData.apiKey" type="password" class="form-input" placeholder="输入您的 API 密钥" autocomplete="off">
            <p v-if="keyUrl" class="form-hint"><a :href="keyUrl" target="_blank" rel="noopener noreferrer" class="api-doc-link">到 {{ activeProviderName }} 获取 API Key</a></p>
          </div>

          <!-- 名称和地址已经填好；代理、请求头这类很少用的都收在这里 -->
          <details class="provider-more" :open="isEditing && hasAdvancedValues">
            <summary>更多设置</summary>
            <template v-if="!isCustom">
              <div class="form-group">
                <label class="form-label">平台名称</label>
                <input v-model="formData.name" type="text" class="form-input" placeholder="平台名称" required>
              </div>
              <div class="form-group">
                <label class="form-label">API 基础 URL</label>
                <input v-model="formData.baseUrl" type="url" class="form-input" placeholder="https://api.openai.com/v1" required>
                <p class="form-hint">使用中转或其他地区的地址时才需要修改。</p>
              </div>
            </template>
            <div class="form-group">
              <label class="form-label">代理</label>
              <input v-model="formData.proxyUrl" type="text" class="form-input" placeholder="http://127.0.0.1:7890" autocomplete="off">
              <p class="form-hint">留空沿用系统设置。支持 HTTP、HTTPS、SOCKS5、SOCKS5H，可写成 scheme://用户名:密码@地址:端口。只作用于这个提供商。</p>
            </div>
            <div class="form-group">
              <label class="form-label">自定义请求头（JSON）</label>
              <textarea v-model="formData.headers" class="form-input headers-input" rows="3" spellcheck="false" placeholder='{"HTTP-Referer":"https://example.com"}'></textarea>
            </div>
          </details>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue'
import { providers, providerGroupLabels, customApiStyles, CUSTOM_PROVIDER_ID, providerForPlatform, type ProviderDef, type ApiStyle } from '../../../services/providerRegistry'
import { fetchRemoteModelsCatalog, type AIPlatform } from '../../../services/modelConfig'
import { validateProxyUrl } from '../../../services/providerTransport'
import { parseObject } from '../../../services/modelOptionsForm'
import { getPlatformIconDisplayUrl, isImageIconValue, resolvePlatformIconUrl } from '../../../services/iconCache'

interface Props {
  show: boolean
  platform?: AIPlatform | null
}

interface Emits {
  (e: 'close'): void
  (e: 'save', platform: Omit<AIPlatform, 'id' | 'isBuiltIn'>): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const isEditing = computed(() => !!props.platform)
// 添加时分两步：先选提供商（pick），再填必要信息（form）。编辑已有平台直接进入 form。
const step = ref<'pick' | 'form'>('pick')
const showForm = computed(() => isEditing.value || step.value === 'form')
const selectedProvider = ref<ProviderDef | null>(null)
const providerSearch = ref('')
const currentProvider = computed(() => props.platform ? providerForPlatform(props.platform) : undefined)
const isCustom = computed(() => isEditing.value
  ? (props.platform?.provider === CUSTOM_PROVIDER_ID || (!props.platform?.provider && !currentProvider.value))
  : formData.value.provider === CUSTOM_PROVIDER_ID)
const activeProviderName = computed(() => selectedProvider.value?.name || currentProvider.value?.name || '')
const hasAdvancedValues = computed(() => !!formData.value.proxyUrl.trim() || !!formData.value.headers.trim())
const keyUrl = computed(() => selectedProvider.value?.keyUrl || currentProvider.value?.keyUrl || '')
const endpointHint = computed(() => customApiStyles.find(item => item.value === formData.value.apiStyle)?.endpoint || '')
const dialogTitle = computed(() => {
  if (isEditing.value) return '编辑平台'
  return step.value === 'pick' ? '选择提供商' : '添加平台'
})

const providerGroups = computed(() => {
  const q = providerSearch.value.trim().toLowerCase()
  const matched = providers.filter(item => !q || item.name.toLowerCase().includes(q) || item.id.includes(q) || item.baseUrl.toLowerCase().includes(q))
  return (Object.keys(providerGroupLabels) as (keyof typeof providerGroupLabels)[])
    .map(key => ({ key, label: providerGroupLabels[key], items: matched.filter(item => item.group === key) }))
    .filter(group => group.items.length > 0)
})

const pickProvider = (item: ProviderDef) => {
  selectedProvider.value = item
  formData.value = { ...formData.value, name: item.name, baseUrl: item.baseUrl, provider: item.id, apiStyle: item.apiStyle }
  step.value = 'form'
}

const pickCustom = () => {
  selectedProvider.value = null
  formData.value = { ...formData.value, name: '', baseUrl: '', provider: CUSTOM_PROVIDER_ID, apiStyle: 'openai-chat' }
  step.value = 'form'
}

const handleBack = () => {
  if (!isEditing.value && step.value === 'form') {
    step.value = 'pick'
    return
  }
  emit('close')
}

const formData = ref({
  name: '',
  baseUrl: '',
  apiKey: '',
  icon: '',
  provider: '' as string,
  apiStyle: 'openai-chat' as ApiStyle,
  proxyUrl: '',
  headers: ''
})

// 图标相关状态
const iconLoadError = ref(false)
const iconError = ref('')
const showIconPicker = ref(false)
const iconPreviewRef = ref<HTMLElement | null>(null)
const iconPickerRef = ref<HTMLElement | null>(null)

const pickerStyle = ref<Record<string, string>>({})

const updatePickerPosition = () => {
  if (!iconPreviewRef.value) return
  const previewRect = iconPreviewRef.value.getBoundingClientRect()
  // 用实际渲染宽度，fallback 到 CSS 计算值
  const pickerWidth = iconPickerRef.value
    ? iconPickerRef.value.getBoundingClientRect().width
    : Math.min(520, window.innerWidth * 0.8)
  const centerX = previewRect.left + previewRect.width / 2
  let left = centerX - pickerWidth / 2
  if (left + pickerWidth > window.innerWidth - 8) left = window.innerWidth - pickerWidth - 8
  if (left < 8) left = 8
  console.log('[picker] previewRect:', previewRect, 'centerX:', centerX, 'pickerWidth:', pickerWidth, 'left:', left)
  pickerStyle.value = {
    top: `${previewRect.bottom + 8}px`,
    left: `${left}px`,
  }
}

const toggleIconPicker = async () => {
  showIconPicker.value = !showIconPicker.value
  if (showIconPicker.value) {
    await nextTick()
    await nextTick() // 第二次确保 picker DOM 完全渲染
    updatePickerPosition()
  }
}

// 可用图标列表
const availableIcons = ref<string[]>([])
const iconUrls = ref<Record<string, string>>({})
const resolvedIconUrls = ref<Record<string, string>>({})
const emojiOptions = ['🤖', '🧠', '🔍', '⚡', '🚀', '💡', '🎯', '🔥', '⭐', '💎', '🌟', '🎨']

const primeIconUrlCache = async (icon?: string) => {
  if (!icon || !isImageIconValue(icon)) return

  resolvedIconUrls.value[icon] = getPlatformIconDisplayUrl(icon)

  try {
    resolvedIconUrls.value[icon] = await resolvePlatformIconUrl(icon)
    if (formData.value.icon === icon) {
      iconLoadError.value = false
    }
  } catch (error) {
    console.warn('缓存平台图标失败，回退到原始地址:', icon, error)
  }
}

// 获取可用图标列表
const loadAvailableIcons = async () => {
  iconError.value = ''

  try {
    const catalog = await fetchRemoteModelsCatalog()
    availableIcons.value = catalog.providersList
  } catch (error: any) {
    console.warn('加载 providers_list 失败:', error)
    availableIcons.value = []
    iconError.value = error?.message || '图标列表加载失败'
  }

  for (const icon of availableIcons.value) {
    iconUrls.value[icon] = getPlatformIconDisplayUrl(icon)
  }
}

const resetForm = () => {
  formData.value = {
    name: '',
    baseUrl: '',
    apiKey: '',
    icon: '',
    provider: '',
    apiStyle: 'openai-chat',
    proxyUrl: '',
    headers: ''
  }
  step.value = 'pick'
  selectedProvider.value = null
  providerSearch.value = ''
  iconLoadError.value = false
  iconError.value = ''
}

// 图标相关方法
const isImageIcon = (icon: string) => isImageIconValue(icon)

const getIconUrl = (icon: string) => {
  if (!icon) return ''
  return resolvedIconUrls.value[icon] || getPlatformIconDisplayUrl(icon) || icon
}

watch(() => formData.value.icon, (icon) => {
  if (icon) {
    void primeIconUrlCache(icon)
    iconLoadError.value = false
  }
})

const getInitials = (name: string) => {
  return name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase())
    .join('')
    .substring(0, 2)
}

const selectIcon = (icon: string) => {
  formData.value.icon = icon
  iconLoadError.value = false
  showIconPicker.value = false
}

const handleIconLoadError = () => {
  console.error('❌ [DEBUG] Icon load error for:', formData.value.icon)
  iconLoadError.value = true
}

const handleIconError = (icon: string) => {
  console.warn(`图标加载失败: ${icon}`)
}

// 监听平台数据变化，初始化表单
watch(() => props.platform, (platform) => {
  if (platform) {
    formData.value = {
      name: platform.name,
      baseUrl: platform.baseUrl,
      apiKey: platform.apiKey || '',
      icon: platform.icon || '',
      provider: platform.provider || '',
      apiStyle: platform.apiStyle || 'openai-chat',
      proxyUrl: platform.proxyUrl || '',
      headers: platform.customHeaders && Object.keys(platform.customHeaders).length ? JSON.stringify(platform.customHeaders, null, 2) : ''
    }
  } else {
    resetForm()
  }
}, { immediate: true })

// 打开时：加载图标列表
watch(() => props.show, (show) => {
  if (show) {
    loadAvailableIcons()
    showIconPicker.value = false
    // 每次打开「添加」都从选提供商开始
    if (!props.platform) resetForm()
  }
})

const handleSubmit = () => {
  if (!formData.value.name.trim()) {
    alert('请填写平台名称')
    return
  }
  if (!formData.value.baseUrl.trim()) {
    alert('请填写 API 基础URL')
    return
  }
  // 代理和请求头：先校验，错误直接提示，不要存进去之后请求时才报错
  let proxyUrl = ''
  let customHeaders: Record<string, string> = {}
  try {
    proxyUrl = validateProxyUrl(formData.value.proxyUrl)
    customHeaders = formData.value.headers.trim() ? parseObject(formData.value.headers, '请求头') as Record<string, string> : {}
    if (Object.values(customHeaders).some(value => typeof value !== 'string')) throw new Error('请求头的值必须是字符串')
    new Headers(customHeaders)
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
    return
  }
  const platformData: any = {
    proxyUrl,
    customHeaders,
    name: formData.value.name,
    displayName: formData.value.name,
    baseUrl: formData.value.baseUrl,
    apiKey: formData.value.apiKey || undefined,
    icon: formData.value.icon || undefined,
    enabled: props.platform?.enabled ?? true
  }
  // 新增时记录选的提供商；自定义提供商再记录它兼容的标准 API。编辑时只在自定义平台上改 apiStyle。
  if (!isEditing.value) {
    platformData.provider = formData.value.provider || CUSTOM_PROVIDER_ID
    if (isCustom.value) platformData.apiStyle = formData.value.apiStyle
  } else if (isCustom.value) {
    platformData.apiStyle = formData.value.apiStyle
  }
  
  // 只有在创建新平台时才提供空的模型数组
  // 编辑现有平台时不传递 models 字段，避免覆盖现有模型
  if (!isEditing.value) {
    platformData.models = []
  }
  
  emit('save', platformData)
}

const handleOverlayClick = (event: MouseEvent) => {
  // 检查点击是否来自输入框或其相关操作
  const target = event.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || 
      target.closest('input') || target.closest('textarea') || target.closest('select')) {
    return
  }
  
  // 使用 setTimeout 延迟检查文本选择状态，避免时序问题
  setTimeout(() => {
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      return
    }
    
    // 检查是否有任何输入框处于焦点状态
    const activeElement = document.activeElement
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'SELECT')) {
      return
    }
    
    emit('close')
  }, 0)
}

</script>

<style>
@import '../../../styles/dialog.css';
</style>

<style scoped>
/* 组件私有样式：dialog-content 尺寸覆盖 */
.dialog-content {
  background: var(--platform-config-dialog-bg);
  border: 1px solid var(--platform-config-dialog-border);
  border-radius: 12px;
  width: 90%;
  max-width: 600px;
  max-height: 90vh;
  overflow: clip;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  transform-origin: center center;
  backface-visibility: hidden;
  animation: popup-in 180ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
}

.btn-confirm-placeholder { width: 56px; }
.provider-picker { display: grid; gap: 8px; padding-bottom: 8px; max-height: 64vh; overflow-y: auto; padding-right: 4px; }
.provider-search { margin-bottom: 4px; }
.provider-group-title { font-size: 12px; color: var(--text-secondary, #667085); margin-top: 8px; }
.provider-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.provider-card {
  display: flex; flex-direction: column; justify-content: center; gap: 2px;
  padding: 8px 12px; min-height: 40px; text-align: left; cursor: pointer;
  border: 1px solid var(--platform-config-dialog-border, #8884); border-radius: 8px;
  background: transparent; color: inherit; font: inherit;
}
.provider-card:hover { border-color: #f7b32b; background: rgba(247, 179, 43, 0.08); }
.provider-card-name { font-size: 13px; font-weight: 500; line-height: 1.3; }
.provider-card-sub { font-size: 11px; opacity: 0.7; line-height: 1.4; }
.provider-card--custom { width: 100%; border-style: dashed; }
.provider-chosen { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
.provider-more { margin-top: 4px; }
.headers-input { font-family: monospace; resize: vertical; }
.provider-more summary { cursor: pointer; padding: 8px 0; font-size: 13px; }
.provider-more .form-group { margin-top: 8px; }
.form-hint { font-size: 12px; line-height: 1.6; color: var(--text-secondary, #667085); margin: 6px 0 0; }
.btn-secondary:hover {
  background: var(--platform-config-btn-secondary-hover-bg);
  color: var(--platform-config-btn-secondary-hover-text);
}

</style>
