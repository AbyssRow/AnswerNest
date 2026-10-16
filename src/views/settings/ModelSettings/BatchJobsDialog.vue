<template>
  <div class="dialog-overlay" @click.self="close">
    <section class="dialog-panel batch-panel" role="dialog" aria-modal="true" aria-label="Batch API">
      <header class="dialog-header">
        <h3 class="dialog-title">Batch API · {{ platform.displayName }}</h3>
        <button class="btn-confirm" :disabled="!!busy" @click="close">关闭</button>
      </header>
      <div class="dialog-body">
        <p class="form-hint">提交给上游异步处理，可能需要数小时。关闭窗口不影响已提交任务；可稍后刷新状态。此处不会替代实时答题。</p>
        <fieldset :disabled="!!busy">
          <label class="form-label">用于生成请求的模型
            <select v-model="modelId" class="form-input">
              <option v-for="model in platform.models.filter(m => m.apiProtocol !== 'custom' && m.apiProtocol !== 'decision')" :key="model.id" :value="model.id">{{ model.displayName }}</option>
            </select>
          </label>
          <p v-if="!suggested" class="form-hint">此提供商的 Batch 流程未自动适配。Gemini / xAI 使用不同的文件或任务接口；只有确认上游支持以下协议时才手动选择。</p>
          <div class="batch-grid">
            <label class="form-label">Batch 协议
              <select v-model="kind" class="form-input">
                <option value="">请选择支持的协议</option>
                <option value="openai">OpenAI 兼容（含百炼 / Groq）</option>
                <option value="anthropic">Anthropic Message Batches</option>
                <option value="mistral">Mistral Batch Jobs</option>
              </select>
            </label>
            <label class="form-label">请求端点
              <select v-model="endpoint" class="form-input">
                <option v-if="kind === 'anthropic'" value="/v1/messages">/v1/messages</option>
                <template v-else>
                  <option value="/v1/chat/completions">/v1/chat/completions</option>
                  <option v-if="kind === 'openai'" value="/v1/responses">/v1/responses</option>
                </template>
              </select>
            </label>
          </div>
          <details>
            <summary>从问题生成 JSONL</summary>
            <textarea v-model="prompts" class="form-input" rows="3" placeholder="每行一个问题；生成时使用所选模型的参数" />
            <button class="btn-secondary" type="button" :disabled="!selectedModel || !prompts.trim()" @click="generate">生成请求</button>
          </details>
          <label class="form-label">导入 JSONL（最多 20 MiB / 50000 条）
            <input type="file" accept=".jsonl,.ndjson,.txt" @change="importFile" />
          </label>
          <textarea v-model="jsonl" class="form-input jsonl" rows="7" spellcheck="false" aria-label="Batch JSONL 请求" placeholder='每行一个请求，必须包含唯一 custom_id 及 body（Anthropic 使用 params）' />
          <p class="form-hint">导入内容按原参数提交，不会用所选模型覆盖文件中的 model。每批只能使用一个端点，且不支持 stream: true。</p>
          <button class="btn-primary" :disabled="!kind || !jsonl.trim()" @click="submit">提交 Batch</button>
        </fieldset>
        <p v-if="busy" role="status">{{ busy }}</p>
        <p v-if="error" class="batch-error" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <h4>本地任务记录</h4>
        <p v-if="!platformJobs.length" class="form-hint">暂无任务。记录不包含 API Key 或请求内容。</p>
        <article v-for="job in platformJobs" :key="job.id" class="batch-job">
          <code>{{ job.id }}</code>
          <p>{{ job.status }} · {{ new Date(job.createdAt).toLocaleString() }}</p>
          <p v-if="job.counts">{{ Object.entries(job.counts).map(([key, value]) => `${key}: ${value}`).join(' · ') }}</p>
          <pre v-if="job.errors">{{ JSON.stringify(job.errors, null, 2) }}</pre>
          <div class="batch-actions">
            <button class="btn-secondary" :disabled="!!busy" @click="refresh(job)">刷新状态</button>
            <button class="btn-secondary" :disabled="!!busy || isBatchFinished(job)" @click="cancel(job)">取消上游任务</button>
            <button class="btn-secondary" :disabled="!!busy || !(job.outputFileId || (job.kind === 'anthropic' && job.status === 'ended'))" @click="download(job)">下载结果</button>
            <button v-if="job.errorFileId" class="btn-secondary" :disabled="!!busy" @click="download(job, true)">下载错误文件</button>
          </div>
        </article>
        <details>
          <summary>找回已有任务</summary>
          <p class="form-hint">使用上方选择的 Batch 协议查询任务 ID。</p>
          <input v-model="existingId" class="form-input" placeholder="batch_... / msgbatch_... / job UUID" />
          <button class="btn-secondary" :disabled="!!busy || !kind || !existingId.trim()" @click="recover">查询并保存</button>
        </details>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AIPlatform } from '../../../services/modelConfig'
import { BatchApi, BATCH_MAX_BYTES, batchRowsFromPrompts, suggestedBatchKind, isBatchFinished, type BatchJob, type BatchKind } from '../../../services/batchApi'
const props = defineProps<{ platform: AIPlatform }>()
const emit = defineEmits<{ close: [] }>()
const modelId = ref(props.platform.models.find(model => model.apiProtocol !== 'custom' && model.apiProtocol !== 'decision')?.id || '')
const selectedModel = computed(() => props.platform.models.find(model => model.id === modelId.value))
const suggested = computed(() => {
  try { return suggestedBatchKind(props.platform, selectedModel.value) } catch { return null }
})
const kind = ref<BatchKind | ''>('')
const endpoint = ref('/v1/chat/completions')
watch(suggested, value => { kind.value = value || '' }, { immediate: true })
watch([kind, selectedModel], () => {
  endpoint.value = kind.value === 'anthropic' ? '/v1/messages' : kind.value === 'openai' && selectedModel.value?.apiProtocol === 'openai-response' ? '/v1/responses' : '/v1/chat/completions'
}, { immediate: true })
const jsonl = ref(''), prompts = ref(''), busy = ref(''), error = ref(''), notice = ref(''), existingId = ref('')
const storageKey = 'zerror.batchJobs.v1'
const jobs = ref<BatchJob[]>([])
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) || '[]')
  if (Array.isArray(stored)) jobs.value = stored.filter(job => job && typeof job.id === 'string' && typeof job.baseUrl === 'string' && ['openai', 'anthropic', 'mistral'].includes(job.kind))
} catch { error.value = '无法读取本地任务记录；可用任务 ID 找回' }
const platformJobs = computed(() => jobs.value.filter(job => job.platformId === props.platform.id))
function saveJob(job: BatchJob) {
  jobs.value = [job, ...jobs.value.filter(old => !(old.id === job.id && old.platformId === job.platformId))]
  try { localStorage.setItem(storageKey, JSON.stringify(jobs.value)) }
  catch { notice.value = `任务 ${job.id} 已接收，但本地保存失败。请复制 ID 以便找回。` }
}
async function run(label: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = label; error.value = ''; notice.value = ''
  try { await action() } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = '' }
}
function close() { if (!busy.value) emit('close') }
function api(batchKind: BatchKind) { return new BatchApi({ ...props.platform }, batchKind) }
async function generate() {
  await run('正在生成请求…', async () => {
    if (!selectedModel.value) throw new Error('请选择模型')
    jsonl.value = await batchRowsFromPrompts(props.platform, selectedModel.value, prompts.value.split(/\r?\n/).filter(line => line.trim()))
    const protocol = selectedModel.value.apiProtocol
    if (protocol === 'anthropic') kind.value = 'anthropic'
    endpoint.value = protocol === 'anthropic' ? '/v1/messages' : protocol === 'openai-response' ? '/v1/responses' : '/v1/chat/completions'
  })
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await run('读取文件…', async () => {
    if (file.size > BATCH_MAX_BYTES) throw new Error('文件超过 20 MiB，请拆分后导入')
    jsonl.value = await file.text()
  })
  input.value = ''
}
async function submit() {
  await run('正在提交，请勿关闭窗口…', async () => {
    if (!kind.value) throw new Error('请选择 Batch 协议')
    const job = await api(kind.value).create(jsonl.value, endpoint.value, AbortSignal.timeout(120000))
    saveJob(job)
    jsonl.value = ''
    if (!notice.value) notice.value = `已提交：${job.id}`
  })
}
async function refresh(job: BatchJob) { await run('查询状态…', async () => { saveJob(await api(job.kind).retrieve(job, AbortSignal.timeout(30000))) }) }
async function cancel(job: BatchJob) { await run('申请取消上游任务…', async () => { saveJob(await api(job.kind).cancel(job, AbortSignal.timeout(30000))) }) }
async function recover() {
  if (!kind.value) return
  await refresh({ id: existingId.value.trim(), platformId: props.platform.id, baseUrl: props.platform.baseUrl, kind: kind.value, status: 'unknown', createdAt: new Date().toISOString(), counts: {} })
}
async function download(job: BatchJob, errors = false) {
  await run('下载结果…', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: `${job.id.replace(/[^\w-]/g, '_')}${errors ? '-errors' : ''}.jsonl`, filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] })
    if (!path) return
    const text = await api(job.kind).results(job, errors, AbortSignal.timeout(120000))
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(path, new TextEncoder().encode(text))
    notice.value = '结果已保存'
  })
}
</script>

<style scoped>
@import '../../../styles/dialog.css';
.batch-panel { width: min(900px, 94vw); max-width: 900px; color: var(--platform-config-dialog-title-text); }
fieldset { border: 0; padding: 0; display: grid; gap: 12px; min-width: 0; }
.batch-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.jsonl { font-family: monospace; white-space: pre; }
textarea { resize: vertical; }
summary { cursor: pointer; padding: 10px 0; }
.batch-error { color: #e5484d; white-space: pre-wrap; overflow-wrap: anywhere; }
.batch-job { border: 1px solid var(--border-color, #8885); border-radius: 8px; padding: 12px; margin: 12px 0; overflow-wrap: anywhere; }
.batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
pre { white-space: pre-wrap; max-height: 180px; overflow: auto; }
.form-hint { font-size: 12px; line-height: 1.6; color: var(--text-secondary, #667085); }
.btn-primary, .btn-secondary { border: 1px solid var(--border-color, #8885); border-radius: 7px; padding: 8px 12px; background: var(--platform-config-dialog-bg); color: inherit; cursor: pointer; }
.btn-primary { background: var(--primary-color, #ffb52e); color: #222; font-weight: 600; }
button:disabled { cursor: default; opacity: 0.45; }
@media (max-width: 600px) { .batch-grid { grid-template-columns: 1fr; } }
</style>
