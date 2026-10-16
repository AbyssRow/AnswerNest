import type { BatchJob, BatchKind } from './batchApi'
import type { AIModel } from './modelConfig'

const STATUS_LABELS: Record<string, string> = {
  validating: '校验中',
  in_progress: '处理中',
  finalizing: '收尾中',
  completed: '已完成',
  ended: '已完成',
  succeeded: '已完成',
  failed: '失败',
  expired: '已过期',
  cancelling: '取消中',
  canceling: '取消中',
  cancelled: '已取消',
  canceled: '已取消',
  unknown: '未知',
}

/** 把各家不同的状态词统一成中文，没见过的状态原样显示 */
export function batchStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** 各家 Batch 的共同点：处理要等一段时间，比实时便宜。说明文字按规范分别写，不让用户去选「协议」 */
export const batchSpecNotes: Record<BatchKind, string> = {
  openai: '上传请求文件后异步处理，24 小时内完成，费用通常是实时调用的一半。',
  anthropic: 'Message Batches：异步处理，24 小时内完成，费用是实时调用的一半。',
  mistral: 'Batch Jobs：异步处理，费用通常低于实时调用。',
  openrouter: 'OpenRouter Batch：直接提交请求，24 小时内完成，使用 :batch 的批量价格；图片和文件必须是公开链接。',
}

/** 这个任务现在能不能下载结果 */
export function canDownloadResults(job: BatchJob): boolean {
  if (job.kind === 'anthropic') return job.status === 'ended'
  if (job.kind === 'openrouter') return job.status === 'completed'
  return !!job.outputFileId
}

/** 请求体里的端点：按模型协议决定，不让用户手选 */
export function endpointForModel(kind: BatchKind, model?: Pick<AIModel, 'apiProtocol'>): string {
  if (kind === 'anthropic' || model?.apiProtocol === 'anthropic') return '/v1/messages'
  if (model?.apiProtocol === 'openai-response' && (kind === 'openai' || kind === 'openrouter')) return '/v1/responses'
  return '/v1/chat/completions'
}
