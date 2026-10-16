<template>
  <details class="connection-settings">
    <summary>网络代理与请求头</summary>
    <label class="form-label">代理 URL
      <input v-model="proxyUrl" class="form-input" type="password" autocomplete="off" placeholder="http://127.0.0.1:7890" />
    </label>
    <p class="form-hint">留空沿用系统设置。支持 HTTP、HTTPS、SOCKS5、SOCKS5H；可使用 scheme://user:password@host:port。仅作用于此提供商。</p>
    <label class="form-label">自定义请求头（JSON）
      <textarea v-model="headers" class="form-input" rows="4" spellcheck="false" placeholder='{"HTTP-Referer":"https://example.com"}' />
    </label>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <button type="button" class="btn-secondary" @click="save">保存连接设置</button>
    <span v-if="saved" role="status">已保存</span>
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { AIPlatform } from '../../../services/modelConfig'
import { validateProxyUrl } from '../../../services/providerTransport'
import { parseObject } from '../../../services/modelOptionsForm'
const props = defineProps<{ platform: AIPlatform }>()
const emit = defineEmits<{ save: [updates: Partial<AIPlatform>] }>()
const proxyUrl = ref(''), headers = ref('{}'), error = ref(''), saved = ref(false)
watch(() => [props.platform.id, props.platform.proxyUrl, props.platform.customHeaders], () => {
  proxyUrl.value = props.platform.proxyUrl || ''
  headers.value = JSON.stringify(props.platform.customHeaders || {}, null, 2)
  error.value = ''; saved.value = false
}, { immediate: true })
watch([proxyUrl, headers], () => { saved.value = false })
function save() {
  try {
    const customHeaders = parseObject(headers.value, '请求头')
    if (Object.values(customHeaders).some(value => typeof value !== 'string')) throw new Error('请求头的值必须是字符串')
    new Headers(customHeaders)
    emit('save', { proxyUrl: validateProxyUrl(proxyUrl.value), customHeaders })
    error.value = ''; saved.value = true
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
</script>

<style scoped>
.connection-settings { display: grid; gap: 12px; margin-top: 16px; }
summary { cursor: pointer; margin-bottom: 12px; }
.error { color: #e5484d; }
textarea { font-family: monospace; resize: vertical; }
.form-hint { font-size: 12px; line-height: 1.6; color: var(--text-secondary, #667085); }
.btn-secondary { border: 1px solid var(--border-color, #8885); border-radius: 7px; padding: 8px 12px; background: var(--platform-config-dialog-bg); color: inherit; cursor: pointer; }
</style>
