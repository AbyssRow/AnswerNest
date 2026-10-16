import { providerEndpoint, providerHeaders, type ProviderConnection } from './providerTransport'
import { parseUrlOptions } from '../utils/urlQuestion'

export type DecisionKind = 'single' | 'multiple' | 'judgement'

const NOUL_YES = 0.5

export const decisionKindFromPrompt = (query: string): DecisionKind | null => {
  const type = query.match(/【题目类型：([^】]+)】/)?.[1] || ''
  if (/多选/.test(type)) return 'multiple'
  if (/判断/.test(type)) return 'judgement'
  if (/单选|选择/.test(type)) return 'single'
  return null
}

export const decisionCanAnswer = (query: string, hasImages = false): boolean =>
  !hasImages && decisionKindFromPrompt(query) !== null

const section = (query: string, name: string): string => {
  const end = name === '题目' ? '(?=\\n【选项】|\\n请作答|$)' : '(?=\\n请作答|$)'
  const match = query.match(new RegExp(`【${name}】\\n([\\s\\S]*?)${end}`))
  return match?.[1]?.trim() || ''
}

export const decisionOptionTexts = (options: string): string[] => {
  const map = parseUrlOptions(options, { allowLineFallback: true })
  const texts = [...map.values()].map(text => text.trim()).filter(Boolean)
  return texts.length >= 2 ? texts : []
}

const uniqueKeys = (texts: string[]): string[] => {
  const seen = new Map<string, number>()
  return texts.map(text => {
    const count = seen.get(text) || 0
    seen.set(text, count + 1)
    return count === 0 ? text : `${text} (${count + 1})`
  })
}

export const buildDecisionPayload = (modelId: string, query: string, fileText = ''): Record<string, unknown> | null => {
  const kind = decisionKindFromPrompt(query)
  if (!kind || !modelId.trim()) return null
  const title = section(query, '题目') || query.trim()
  const options = section(query, '选项')
  const state = [title, options ? `选项：\n${options}` : '', fileText ? `附件：\n${fileText}` : ''].filter(Boolean).join('\n\n')
  if (kind === 'judgement') {
    return {
      model: modelId,
      state,
      questions: {
        judge: {
          type: 'noul',
          instructions: '这个说法是否正确？正确选是，错误选否。',
          criteria: { true: '正确', false: '错误' }
        }
      }
    }
  }
  const texts = uniqueKeys(decisionOptionTexts(options)).slice(0, 16)
  if (texts.length < 2) return null
  if (kind === 'single') {
    return {
      model: modelId,
      state,
      questions: {
        answer: {
          type: 'choice',
          instructions: '选择唯一正确答案，只能从给定选项里选。',
          criteria: Object.fromEntries(texts.map(text => [text, text]))
        }
      }
    }
  }
  const questions: Record<string, unknown> = {}
  texts.forEach((text, index) => {
    questions[`opt${index}`] = {
      type: 'noul',
      instructions: `选项「${text}」是否应选？`,
      criteria: { true: '应选', false: '不选' }
    }
  })
  return { model: modelId, state, questions }
}

const readAnswers = (body: any): Record<string, any> | null => {
  const objectAnswers = body?.answers && !Array.isArray(body.answers) ? body.answers : body?.data?.result?.answers
  if (objectAnswers && typeof objectAnswers === 'object' && !Array.isArray(objectAnswers)) return objectAnswers
  if (!Array.isArray(body?.answers)) return null
  return Object.fromEntries(body.answers.filter((item: any) => item?.name).map((item: any) => [item.name, item]))
}

const yesProbability = (answer: any): number => {
  if (typeof answer?.noul === 'number') return answer.noul
  if (typeof answer?.probability === 'number') return answer.probability
  return 0
}

export const formatDecisionAnswer = (body: any, payload: Record<string, unknown>): string => {
  const answers = readAnswers(body)
  if (!answers) {
    const message = body?.error?.message || body?.message || '决策模型没有返回答案'
    throw new Error(message)
  }
  const questions = payload.questions as Record<string, any>
  if (questions.judge) {
    return JSON.stringify({ answer: yesProbability(answers.judge) >= NOUL_YES ? '正确' : '错误' })
  }
  if (questions.answer) {
    const choice = String(answers.answer?.choice || '').trim()
    if (!choice) throw new Error('决策模型没有选出选项')
    return JSON.stringify({ answer: choice })
  }
  const picked = Object.keys(questions)
    .map(id => ({ id, text: String(questions[id]?.instructions || '').match(/选项「([\s\S]*)」是否应选/)?.[1] || '', p: yesProbability(answers[id]) }))
    .filter(item => item.text)
  const chosen = picked.filter(item => item.p >= NOUL_YES)
  const finals = chosen.length ? chosen : picked.sort((a, b) => b.p - a.p).slice(0, 1)
  if (!finals.length || !finals[0].text) throw new Error('决策模型没有选出选项')
  return JSON.stringify({ answer: finals.map(item => item.text).join('###') })
}

export function decisionEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  if (/\/(?:systemone|decisions)$/i.test(path)) return url.toString()
  return providerEndpoint(baseUrl, 'systemone')
}

export async function callDecisionModel(options: {
  query: string
  modelId: string
  platform: ProviderConnection
  fileText?: string
  fetchImpl: typeof fetch
  signal?: AbortSignal
}): Promise<string> {
  if (!options.modelId.trim()) throw new Error('请填写模型 ID')
  const payload = buildDecisionPayload(options.modelId, options.query, options.fileText || '')
  if (!payload) throw new Error('决策模型只回答选择题和判断题')
  const headers = providerHeaders(options.platform)
  if (!headers.has('content-type')) headers.set('Content-Type', 'application/json')
  const response = await options.fetchImpl(decisionEndpoint(options.platform.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.signal
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `决策模型请求失败 ${response.status}`)
  }
  return formatDecisionAnswer(body, payload)
}
