import type { AIModel } from '../services/modelConfig'

const URL_RE = /https?:\/\/[^\s<>"'，。；、]+/gi
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i
const FILE_EXT_RE = /\.(?:pdf|docx?|xlsx?|csv|txt|pptx?)(?:$|[?#])/i
const VISION_NAME_RE = /(?:gpt-4o|gpt-4\.1|gpt-5|gpt-4-turbo|gemini|claude-(?:3|4|sonnet|opus|haiku)|qwen[\w.-]*vl|glm-4v|pixtral|llava|internvl|minicpm-v|step-1v|grok-[\w.-]*vision|yi-vision|\bvision\b)/i

export const FILE_TEXT_CHAR_LIMIT = 8000
const FILE_COUNT_LIMIT = 4
const FILE_BYTE_LIMIT = 6 * 1024 * 1024

export const modelSupportsVision = (model: { supportsVision?: boolean; category?: string } | null | undefined): boolean =>
  !!model && (model.supportsVision === true || model.category === 'vision')

export const inferSupportsVision = (model: { id?: string; name?: string; displayName?: string; modelId?: string; category?: string }): boolean => {
  if (model.category === 'vision') return true
  const probe = `${model.modelId || ''} ${model.id || ''} ${model.name || ''} ${model.displayName || ''}`
  return VISION_NAME_RE.test(probe)
}

export const pickAnswerModels = <T extends { supportsVision?: boolean; category?: string; apiProtocol?: string }>(models: T[], hasImages: boolean): T[] =>
  // 决策模型不处理图片题，即使被误标为视觉模型也不能用来答图片题
  hasImages ? models.filter(model => modelSupportsVision(model) && model.apiProtocol !== 'decision') : models

const trimUrl = (raw: string): string => raw.replace(/[),.;!?，。；、]+$/g, '')

export const findHttpUrls = (text: string): string[] => {
  const found = String(text || '').match(URL_RE) || []
  return [...new Set(found.map(trimUrl).filter(Boolean))]
}

export const findImageUrls = (text: string): string[] =>
  findHttpUrls(text).filter(url => IMAGE_EXT_RE.test(url.split('?')[0]))

export const findFileUrls = (text: string): string[] =>
  findHttpUrls(text).filter(url => FILE_EXT_RE.test(url.split('?')[0]) && !IMAGE_EXT_RE.test(url.split('?')[0]))

export const questionHasImages = (text: string, extraImages?: string[]): boolean =>
  (extraImages || []).some(item => typeof item === 'string' && item.trim()) || findImageUrls(text).length > 0

/** 等待原生下载时也响应取消；底层请求完成后的结果不再参与本次作答。 */
export function waitForAttachment<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

/** 失败的链接最多下载三次；已成功的图片保留，全部就绪后才作答。 */
export async function loadQuestionImages(
  urls: string[],
  fetchImage: (url: string) => Promise<string>,
  options: { signal?: AbortSignal; retryDelayMs?: number } = {}
): Promise<string[]> {
  const unique = [...new Set(urls.filter(Boolean))]
  const images: string[] = []
  const failed: number[] = []
  for (const [index, url] of unique.entries()) {
    options.signal?.throwIfAborted()
    let data = url.startsWith('data:') ? url : ''
    for (let attempt = 0; !data && attempt < 3; attempt++) {
      options.signal?.throwIfAborted()
      try {
        data = await waitForAttachment(fetchImage(url), options.signal)
      } catch {
        options.signal?.throwIfAborted()
      }
      if (!data && attempt < 2) {
        await waitForAttachment(new Promise<void>(resolve => setTimeout(resolve, (options.retryDelayMs ?? 250) * 2 ** attempt)), options.signal)
      }
    }
    if (data) images.push(data)
    else failed.push(index + 1)
  }
  options.signal?.throwIfAborted()
  if (failed.length) throw new Error(`题目图片重试后仍未能全部加载（${failed.length}/${unique.length}，第 ${failed.join('、')} 张），请重试。`)
  return images
}

const fileKind = (url: string): string => {
  const path = url.split('?')[0].toLowerCase()
  if (path.endsWith('.pdf')) return 'pdf'
  if (path.endsWith('.docx') || path.endsWith('.doc')) return 'docx'
  if (path.endsWith('.xlsx') || path.endsWith('.xls')) return 'xlsx'
  if (path.endsWith('.csv') || path.endsWith('.txt')) return 'text'
  return ''
}

const decodeText = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes)

async function bytesToText(kind: string, bytes: Uint8Array): Promise<string> {
  if (kind === 'text') return decodeText(bytes)
  if (kind === 'xlsx') {
    const XLSX = await import('xlsx')
    const sheet = XLSX.read(bytes, { type: 'array' })
    const name = sheet.SheetNames[0]
    if (!name) return ''
    return XLSX.utils.sheet_to_csv(sheet.Sheets[name])
  }
  if (kind === 'docx') {
    const mammoth = await import('mammoth')
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const result = await mammoth.extractRawText({ arrayBuffer })
    return result.value || ''
  }
  if (kind === 'pdf') {
    const pdfjs = await import('pdfjs-dist')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()
    }
    const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise
    const pages = Math.min(pdf.numPages, 8)
    const chunks: string[] = []
    for (let i = 1; i <= pages; i++) {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      chunks.push(content.items.map(item => 'str' in item ? item.str : '').join(' '))
    }
    return chunks.join('\n')
  }
  return ''
}

/** 下载题目里的文件链接并抽出文本。失败只记一行，不中断答题。 */
export async function loadQuestionFileText(text: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  const urls = findFileUrls(text).slice(0, FILE_COUNT_LIMIT)
  if (!urls.length) return ''
  const blocks: string[] = []
  let used = 0
  for (const url of urls) {
    const kind = fileKind(url)
    if (!kind) {
      blocks.push(`[文件] ${url}\n（暂不解析该格式，请根据链接作答）`)
      continue
    }
    try {
      const response = await fetchImpl(url, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > FILE_BYTE_LIMIT) throw new Error('文件超过 6MB')
      let extracted = (await bytesToText(kind, bytes)).replace(/\s+\n/g, '\n').trim()
      if (!extracted) throw new Error('没有读出文本')
      const room = FILE_TEXT_CHAR_LIMIT - used
      if (room <= 0) break
      if (extracted.length > room) extracted = `${extracted.slice(0, room)}\n…（已截断）`
      used += extracted.length
      blocks.push(`[文件] ${url}\n${extracted}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      blocks.push(`[文件] ${url}\n（读取失败：${message}）`)
    }
  }
  return blocks.join('\n\n')
}

export type VisionProbe = Pick<AIModel, 'id' | 'name' | 'displayName' | 'modelId' | 'category' | 'supportsVision'>
