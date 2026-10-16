import type { AIModel } from './modelConfig'

export function parseObject(text: string, label: string): Record<string, any> {
  let value: unknown
  try { value = JSON.parse(text.trim() || '{}') } catch { throw new Error(`${label}必须是合法 JSON`) }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label}必须是 JSON 对象`)
  if (Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new Error(`${label}包含不支持的字段`)
  return value as Record<string, any>
}

export const numericModelOptions = [
  { key: 'maxTokens', label: '最大输出 Token', min: 1, max: 2000000, step: 1, fallback: 4096 },
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, fallback: 0.7 },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.05, fallback: 1 },
  { key: 'frequencyPenalty', label: '频率惩罚', min: -2, max: 2, step: 0.1 },
  { key: 'presencePenalty', label: '存在惩罚', min: -2, max: 2, step: 0.1 },
  { key: 'seed', label: '随机种子', min: -2147483648, max: 2147483647, step: 1 },
  { key: 'topK', label: 'Top K（百炼）', min: 1, max: 100000, step: 1 },
  { key: 'thinkingBudget', label: '思考 Token 预算', min: 0, max: 2000000, step: 1 },
] as const

export function collectModelOptions(values: Record<string, string | number>, extraText: string, stopText: string, omitText: string): Partial<AIModel> {
  const result: Record<string, any> = {}
  for (const field of numericModelOptions) {
    const raw = String(values[field.key] ?? '').trim()
    if (!raw) {
      if ('fallback' in field) throw new Error(`请填写${field.label}`)
      result[field.key] = undefined
      continue
    }
    const value = Number(raw)
    if (!Number.isFinite(value) || value < field.min || value > field.max || (field.step === 1 && !Number.isInteger(value))) {
      throw new Error(`${field.label}必须在 ${field.min} 到 ${field.max} 之间${field.step === 1 ? '，且为整数' : ''}`)
    }
    result[field.key] = value
  }
  result.extraBody = parseObject(extraText, '额外参数')
  result.stop = stopText.split('\n').filter(Boolean)
  result.omitParameters = omitText.split(',').map(s => s.trim()).filter(Boolean)
  const reserved = ['model', 'stream', 'messages', 'input', '__proto__', 'constructor', 'prototype']
  if (Object.keys(result.extraBody).some(key => reserved.includes(key)) || result.omitParameters.some((key: string) => reserved.includes(key))) {
    throw new Error('不能覆盖或省略 model、stream、messages、input 等结构字段')
  }
  return result
}
