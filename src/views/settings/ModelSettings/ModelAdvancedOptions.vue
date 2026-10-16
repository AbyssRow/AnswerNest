<template>
  <details class="advanced-options">
    <summary>更多参数</summary>
    <fieldset :disabled="disabled">
      <p class="form-hint">不填表示不发送，由提供商使用默认值。思考相关参数在上面的「思考」里设置。</p>
      <div class="parameter-grid">
        <label v-for="field in numericModelOptions" :key="field.key" class="form-label">
          {{ field.label }}
          <input v-model="values[field.key]" class="form-input" type="number" :min="field.min" :max="field.max" :step="field.step" placeholder="不发送" />
        </label>
      </div>
      <label class="form-label">停止序列（每行一个）<textarea v-model="stopText" class="form-input" rows="2" /></label>
      <label v-if="showUpstream" class="form-label">兼容方言
        <select v-model="upstream" class="form-input">
          <option value="auto">自动（按地址识别）</option>
          <option v-for="item in upstreams" :key="item.value" :value="item.value">{{ item.label }}</option>
        </select>
      </label>
      <label class="form-label">额外请求参数（JSON，合并到请求体顶层）<textarea v-model="extraText" class="form-input json-input" rows="4" spellcheck="false" placeholder='{"response_format":{"type":"json_object"}}' /></label>
      <label class="form-label">不发送的参数（逗号分隔）<input v-model="omitText" class="form-input" placeholder="temperature,top_p" /></label>
      <p class="form-hint">模型 ID、消息和流式开关不可覆盖。不同模型支持的参数以提供商文档为准。</p>
    </fieldset>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AIModel } from '../../../services/modelConfig'
import { numericModelOptions, collectModelOptions } from '../../../services/modelOptionsForm'
const props = defineProps<{ model?: AIModel | null; disabled?: boolean; showUpstream?: boolean }>()
const values = ref<Record<string, string>>({})
const upstream = ref<AIModel['upstream']>('auto')
// 自定义提供商才需要手动选；已知提供商由添加平台时选的提供商决定
const upstreams = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义百炼（Qwen）' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'groq', label: 'Groq' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'xai', label: 'xAI' },
  { value: 'moonshot', label: 'Kimi / Moonshot' },
  { value: 'zhipu', label: '智谱' },
  { value: 'volcengine', label: '火山方舟' },
  { value: 'siliconflow', label: '硅基流动' },
  { value: 'compatible', label: '通用 OpenAI 兼容' },
] as const
const extraText = ref('{}'), stopText = ref(''), omitText = ref('')
watch(() => props.model, model => {
  values.value = Object.fromEntries(numericModelOptions.map(field => [field.key, String(model?.[field.key] ?? ('fallback' in field ? field.fallback : ''))]))
  upstream.value = model?.upstream || 'auto'
  extraText.value = JSON.stringify(model?.extraBody || {}, null, 2)
  stopText.value = (model?.stop || []).join('\n')
  omitText.value = (model?.omitParameters || []).join(',')
}, { immediate: true })
defineExpose({
  collect: () => ({
    ...collectModelOptions(values.value, extraText.value, stopText.value, omitText.value),
    // 没有显示方言选择时不改动已有值，避免把按提供商设置的 upstream 覆盖回 auto
    ...(props.showUpstream ? { upstream: upstream.value } : {}),
  }),
})
</script>

<style scoped>
.advanced-options { width: 100%; margin: 12px 0; }
summary { cursor: pointer; padding: 10px 0; }
fieldset { border: 0; padding: 0; display: grid; gap: 12px; min-width: 0; }
.parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.json-input { font-family: monospace; }
textarea { resize: vertical; }
.form-hint { font-size: 12px; line-height: 1.6; color: var(--text-secondary, #667085); margin: 0; }
</style>
