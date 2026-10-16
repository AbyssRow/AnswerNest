<template>
  <details class="advanced-options">
    <summary>模型参数与上游兼容</summary>
    <fieldset :disabled="disabled">
      <label class="form-label">上游适配
        <select v-model="upstream" class="form-input">
          <option value="auto">自动（按官方域名识别）</option>
          <option v-for="name in upstreams" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <label class="form-label">Anthropic 思考模式
        <select v-model="thinkingMode" class="form-input">
          <option value="auto">自动（已知新模型使用自适应）</option>
          <option value="budget">Token 预算</option>
          <option value="adaptive">自适应（模型需支持）</option>
        </select>
      </label>
      <div class="parameter-grid">
        <label v-for="field in numericModelOptions" :key="field.key" class="form-label">
          {{ field.label }}
          <input v-model="values[field.key]" class="form-input" type="number" :min="field.min" :max="field.max" :step="field.step" placeholder="不发送" />
        </label>
      </div>
      <label class="form-label">停止序列（每行一个）<textarea v-model="stopText" class="form-input" rows="2" /></label>
      <label class="form-label">额外请求参数（JSON）<textarea v-model="extraText" class="form-input json-input" rows="5" spellcheck="false" placeholder='{"response_format":{"type":"json_object"}}' /></label>
      <label class="form-label">不发送的参数（逗号分隔）<input v-model="omitText" class="form-input" placeholder="temperature,top_p,reasoning" /></label>
      <p class="form-hint">先应用上游适配，再合并额外参数，最后移除指定字段。模型 ID、消息和流式开关不可覆盖。自定义 JavaScript 协议需在代码中读取这些配置。</p>
      <p class="form-hint">Anthropic 采样参数默认不发送；自适应思考可填写 {"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}。不同模型支持的参数以提供商文档为准。</p>
    </fieldset>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AIModel } from '../../../services/modelConfig'
import { numericModelOptions, collectModelOptions } from '../../../services/modelOptionsForm'
const props = defineProps<{ model?: AIModel | null; disabled?: boolean }>()
const values = ref<Record<string, string>>({})
const upstream = ref<AIModel['upstream']>('auto')
const upstreams = ['openai', 'deepseek', 'qwen', 'gemini', 'openrouter', 'groq', 'mistral', 'xai', 'moonshot', 'zhipu', 'volcengine', 'siliconflow', 'compatible']
const thinkingMode = ref<AIModel['thinkingMode']>('auto')
const extraText = ref('{}'), stopText = ref(''), omitText = ref('')
watch(() => props.model, model => {
  values.value = Object.fromEntries(numericModelOptions.map(field => [field.key, String(model?.[field.key] ?? ('fallback' in field ? field.fallback : ''))]))
  upstream.value = model?.upstream || 'auto'
  thinkingMode.value = model?.thinkingMode || 'auto'
  extraText.value = JSON.stringify(model?.extraBody || {}, null, 2)
  stopText.value = (model?.stop || []).join('\n')
  omitText.value = (model?.omitParameters || []).join(',')
}, { immediate: true })
defineExpose({ collect: () => ({ ...collectModelOptions(values.value, extraText.value, stopText.value, omitText.value), upstream: upstream.value, thinkingMode: thinkingMode.value }) })
</script>

<style scoped>
.advanced-options { width: 100%; margin: 12px 0; }
summary { cursor: pointer; padding: 10px 0; }
fieldset { border: 0; padding: 0; display: grid; gap: 12px; min-width: 0; }
.parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.json-input { font-family: monospace; }
textarea { resize: vertical; }
</style>
