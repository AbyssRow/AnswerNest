<template>
  <div class="dialog-overlay" @click.self="close">
    <section class="dialog-panel batch-panel" role="dialog" aria-modal="true" aria-label="批量处理">
      <header class="dialog-header">
        <h3 class="dialog-title">批量处理 · {{ selectedModel?.displayName || platform.displayName }}</h3>
        <button class="btn-confirm" :disabled="!!busy" @click="close">关闭</button>
      </header>
      <div class="dialog-body">
        <p class="form-hint">{{ note }}提交后可以关闭窗口，之后回来刷新状态并下载结果。这里不会替代实时答题，结果也不会自动写入题库。</p>

        <fieldset :disabled="!!busy" class="batch-form">
          <label v-if="models.length > 1" class="form-label">模型
            <select v-model="modelId" class="form-input">
              <option v-for="model in models" :key="model.id" :value="model.id">{{ model.displayName }}</option>
            </select>
          </label>
          <label class="form-label">要处理的问题（每行一个）
            <textarea v-model="prompts" class="form-input" rows="6" placeholder="每行一个问题。会使用这个模型的参数（温度、思考等）生成请求。" />
          </label>
          <div class="batch-row">
            <button class="btn-primary" :disabled="!canSubmit" @click="submit">提交批量任务</button>
            <label class="btn-secondary file-btn">从文件导入
              <input type="file" accept=".jsonl,.ndjson,.txt" @change="importFile" hidden />
            </label>
            <span v-if="importedName" class="form-hint">已导入 {{ importedName }}（按文件内容提交）</span>
          </div>
        </fieldset>

        <p v-if="busy" role="status">{{ busy }}</p>
        <p v-if="error" class="batch-error" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>

        <h4>任务记录</h4>
        <p v-if="!platformJobs.length" class="form-hint">还没有任务。记录只保存任务 ID 和状态，不含 API Key 和问题内容。</p>
        <article v-for="job in platformJobs" :key="job.id" class="batch-job">
          <div class="batch-job-head">
            <span class="batch-status" :class="`batch-status--${statusTone(job)}`">{{ batchStatusLabel(job.status) }}</span>
            <span class="form-hint">{{ new Date(job.createdAt).toLocaleString() }}</span>
          </div>
          <code class="batch-id">{{ job.id }}</code>
          <p v-if="progressText(job)" class="form-hint">{{ progressText(job) }}</p>
          <pre v-if="job.errors">{{ JSON.stringify(job.errors, null, 2) }}</pre>
          <div class="batch-actions">
            <button class="btn-secondary" :disabled="!!busy" @click="refresh(job)">刷新状态</button>
            <button class="btn-secondary" :disabled="!!busy || !canDownloadResults(job)" @click="download(job)">下载结果</button>
            <button v-if="job.errorFileId" class="btn-secondary" :disabled="!!busy" @click="download(job, true)">下载错误文件</button>
            <button v-if="!isBatchFinished(job) && supportsCancel" class="btn-secondary" :disabled="!!busy" @click="cancel(job)">取消</button>
          </div>
        </article>

        <details class="batch-advanced">
          <summary>高级</summary>
          <label class="form-label">请求端点
            <select v-model="endpoint" class="form-input">
              <option v-if="kind === 'anthropic'" value="/v1/messages">/v1/messages</option>
              <template v-else>
                <option value="/v1/chat/completions">/v1/chat/completions</option>
                <option v-if="kind === 'openai' || kind === 'openrouter'" value="/v1/responses">/v1/responses</option>
              </template>
            </select>
          </label>
          <label class="form-label">直接编辑请求（JSONL，最多 20 MiB / 50000 条）
            <textarea v-model="jsonl" class="form-input jsonl" rows="6" spellcheck="false" placeholder='每行一个请求，必须有唯一的 custom_id 和 body（Anthropic 用 params）。填了这里就按这里提交，不再使用上面的问题。' />
          </label>
          <p class="form-hint">导入或手写的内容按原样提交，不会用所选模型覆盖其中的 model。每批只能用一个端点，且不支持 stream: true。</p>
          <label class="form-label">找回已有任务（输入任务 ID）
            <input v-model="existingId" class="form-input" placeholder="batch_... / msgbatch_... / 任务 UUID" />
          </label>
          <button class="btn-secondary" :disabled="!!busy || !existingId.trim()" @click="recover">查询并保存</button>
        </details>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AIModel, AIPlatform } from '../../../services/modelConfig'
import { BatchApi, BATCH_MAX_BYTES, batchRowsFromPrompts, isBatchFinished, type BatchJob, type BatchKind } from '../../../services/batchApi'
import { batchSpecForPlatform } from '../../../services/providerRegistry'
import { batchSpecNotes, batchStatusLabel, canDownloadResults, endpointForModel } from '../../../services/batchUi'
import { errorMessage } from '../../../utils/errorMessage'

const props = defineProps<{ platform: AIPlatform; modelId?: string }>()
const emit = defineEmits<{ close: [] }>()

// Batch 的规范由提供商决定，不让用户在这里选「协议」
const kind = computed<BatchKind | null>(() => batchSpecForPlatform(props.platform))
const note = computed(() => (kind.value ? batchSpecNotes[kind.value] : '该提供商没有可用的 Batch 接口。'))
// OpenRouter 的 Batch 目前没有取消接口
const supportsCancel = computed(() => kind.value !== 'openrouter')

const models = computed(() => props.platform.models.filter(m => m.apiProtocol !== 'custom' && m.apiProtocol !== 'decision'))
const modelId = ref(props.modelId && models.value.some(m => m.id === props.modelId) ? props.modelId : models.value[0]?.id || '')
const selectedModel = computed<AIModel | undefined>(() => props.platform.models.find(model => model.id === modelId.value))

const endpoint = ref('/v1/chat/completions')
watch([kind, selectedModel], () => {
  if (kind.value) endpoint.value = endpointForModel(kind.value, selectedModel.value)
}, { immediate: true })

const jsonl = ref(''), prompts = ref(''), importedName = ref('')
const busy = ref(''), error = ref(''), notice = ref(''), existingId = ref('')
const canSubmit = computed(() => !!kind.value && !busy.value && (!!jsonl.value.trim() || (!!prompts.value.trim() && !!selectedModel.value)))

const storageKey = 'answernest.batchJobs.v1'
const legacyStorageKey = 'zerror.batchJobs.v1'
const KINDS: BatchKind[] = ['openai', 'anthropic', 'mistral', 'openrouter']
const jobs = ref<BatchJob[]>([])
try {
  const stored = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(legacyStorageKey) ?? '[]')
  if (Array.isArray(stored)) jobs.value = stored.filter(job => job && typeof job.id === 'string' && typeof job.baseUrl === 'string' && KINDS.includes(job.kind))
} catch { error.value = '无法读取本地任务记录；可以用任务 ID 找回' }
const platformJobs = computed(() => jobs.value.filter(job => job.platformId === props.platform.id))

function saveJob(job: BatchJob) {
  jobs.value = [job, ...jobs.value.filter(old => !(old.id === job.id && old.platformId === job.platformId))]
  try { localStorage.setItem(storageKey, JSON.stringify(jobs.value)) }
  catch { notice.value = `任务 ${job.id} 已接收，但本地保存失败。请复制 ID 以便找回。` }
}
async function run(label: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = label; error.value = ''; notice.value = ''
  try { await action() } catch (e) { error.value = errorMessage(e) }
  finally { busy.value = '' }
}
function close() { if (!busy.value) emit('close') }
function api(batchKind: BatchKind) { return new BatchApi({ ...props.platform }, batchKind) }

function statusTone(job: BatchJob): 'ok' | 'bad' | 'wait' {
  if (['completed', 'ended', 'succeeded'].includes(job.status)) return 'ok'
  if (['failed', 'expired', 'cancelled', 'canceled'].includes(job.status)) return 'bad'
  return 'wait'
}
function progressText(job: BatchJob): string {
  const entries = Object.entries(job.counts || {}).filter(([, value]) => typeof value === 'number')
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(' · ') : ''
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await run('读取文件…', async () => {
    if (file.size > BATCH_MAX_BYTES) throw new Error('文件超过 20 MiB，请拆分后导入')
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(line => line.trim())
    // 每行是带 custom_id 的 JSON 对象就当成请求文件；否则当成「每行一个问题」
    const looksLikeJsonl = lines.length > 0 && lines.every(line => { try { const v = JSON.parse(line); return v && typeof v === 'object' && 'custom_id' in v } catch { return false } })
    if (looksLikeJsonl) { jsonl.value = text; importedName.value = file.name }
    else { prompts.value = lines.join('\n'); jsonl.value = ''; importedName.value = '' }
  })
  input.value = ''
}

async function submit() {
  await run('正在提交，请勿关闭窗口…', async () => {
    if (!kind.value) throw new Error('该提供商没有可用的 Batch 接口')
    let body = jsonl.value.trim()
    if (!body) {
      if (!selectedModel.value) throw new Error('请选择模型')
      const lines = prompts.value.split(/\r?\n/).filter(line => line.trim())
      body = await batchRowsFromPrompts(props.platform, selectedModel.value, lines)
    }
    const job = await api(kind.value).create(body, endpoint.value, AbortSignal.timeout(120000), { model: selectedModel.value?.modelId || selectedModel.value?.id })
    saveJob(job)
    jsonl.value = ''; importedName.value = ''; prompts.value = ''
    if (!notice.value) notice.value = `已提交：${job.id}。稍后点「刷新状态」查看进度。`
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
.batch-panel { width: min(760px, 94vw); max-width: 760px; color: var(--platform-config-dialog-title-text); }
.batch-form { border: 0; padding: 0; margin: 14px 0 0; display: grid; gap: 12px; min-width: 0; }
.batch-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.file-btn { display: inline-flex; align-items: center; }
.jsonl { font-family: monospace; white-space: pre; }
textarea { resize: vertical; }
h4 { margin: 18px 0 8px; font-size: 14px; }
.batch-advanced { margin-top: 16px; display: grid; gap: 10px; }
.batch-advanced summary { cursor: pointer; padding: 8px 0; font-size: 13px; }
.batch-error { color: #e5484d; white-space: pre-wrap; overflow-wrap: anywhere; }
.batch-job { border: 1px solid var(--border-color, #8885); border-radius: 8px; padding: 12px; margin: 10px 0; overflow-wrap: anywhere; display: grid; gap: 6px; }
.batch-job-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.batch-status { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(120, 120, 120, 0.15); }
.batch-status--ok { background: rgba(48, 164, 108, 0.18); color: #2b8a5d; }
.batch-status--bad { background: rgba(229, 72, 77, 0.15); color: #e5484d; }
.batch-status--wait { background: rgba(247, 179, 43, 0.2); color: #b7791f; }
.batch-id { font-size: 12px; }
.batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
pre { white-space: pre-wrap; max-height: 180px; overflow: auto; margin: 0; }
.form-hint { font-size: 12px; line-height: 1.6; color: var(--text-secondary, #667085); margin: 0; }
.btn-primary, .btn-secondary { border: 1px solid var(--border-color, #8885); border-radius: 7px; padding: 7px 12px; font-size: 13px; background: var(--platform-config-dialog-bg); color: inherit; cursor: pointer; }
.btn-primary { background: var(--primary-color, #ffb52e); color: #222; font-weight: 600; }
button:disabled { cursor: default; opacity: 0.45; }
</style>
