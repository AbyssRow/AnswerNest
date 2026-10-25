import { isLongFormQuestion, normalizeAnswerAgainstOptions, normalizeLongFormAnswer } from './answerNormalize'

export interface AnswerContext {
  kind?: string
  options?: string
}

export function answerContextFromPrompt(prompt: string): AnswerContext {
  const rawType = prompt.match(/【题目类型字段：([^】]+)】/)?.[1]
  return {
    // No recognised type tag (unknown type, URL prompts) means "unknown", not a strict non-choice type.
    kind: prompt.match(/【题目类型：([^】]+)】/)?.[1] || (isLongFormQuestion(rawType) ? rawType : undefined),
    options: prompt.match(/【选项】\s*\n([\s\S]*?)(?:\n\s*请作答|$)/)?.[1]?.trim() || ''
  }
}

/** Numbers, booleans and arrays are valid answers too: {"answer": 3}, {"answer": true}, {"answer": ["A", "B"]}. */
function answerValueText(value: unknown, context: AnswerContext): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value) && value.every(item => typeof item === 'string' || typeof item === 'number')) {
    return value.map(item => String(item).trim()).join(isLongFormQuestion(context.kind) ? '\n' : '###')
  }
  return undefined
}

/** Read the final answer field, including escaped quotes/Unicode, without comparing model reasoning. */
export function extractFinalAnswer(response: string, context: AnswerContext = {}): string {
  const longForm = isLongFormQuestion(context.kind)
  const text = longForm
    ? (response || '').trim().replace(/^```(?:json)?\s*(\{[\s\S]*\})\s*```$/i, '$1').trim()
    : (response || '').replace(/```[a-z]*\n?|```/gi, '').trim()
  if (/^(?:错误|error)\s*[:：]/i.test(text)) return ''
  let answer: string | undefined
  const field = /"(?:answer|anwser)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|\[(?:[^[\]"]|"(?:[^"\\]|\\.)*")*\])/g
  for (const match of text.matchAll(field)) {
    try { answer = answerValueText(JSON.parse(match[1]), context) ?? answer } catch { /* ignore malformed fields */ }
  }
  if (answer !== undefined) return longForm ? normalizeLongFormAnswer(answer) : answer.trim()
  if (/^[{[]/.test(text)) {
    if (!longForm) return ''
    // Bracketed subquestion numbers and mathematical sets can begin valid prose.
    try { JSON.parse(text); return '' } catch { /* not a complete JSON value */ }
    if (/^(?:\{\s*"|\[\s*[{\"])/.test(text)) return ''
  }
  if (longForm) {
    const labelled = [...text.matchAll(/^(?:最终(?:答案)?|答案|answer)\s*[:：][ \t]*/gmi)]
    const last = labelled[labelled.length - 1]
    return normalizeLongFormAnswer(last ? text.slice(last.index! + last[0].length) : text)
  }
  const labelled = [...text.matchAll(/(?:最终(?:答案)?|答案|answer)\s*[:：]\s*([^\n]+)/gi)]
  if (labelled.length) return labelled[labelled.length - 1][1].trim()
  // Unstructured reply: the conclusion is the last line; the whole text would make every reply "disagree".
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  return lines[lines.length - 1] || ''
}

const JUDGE_TRUE = new Set(['正确', '对', '是', '真', '对的', '正确的', '是的', '√', '✓', '✔', '☑', 'true', 't', 'yes', 'y', 'right', 'correct'])
const JUDGE_FALSE = new Set(['错误', '错', '否', '假', '不对', '不正确', '不是', '错的', '错误的', '不对的', '×', '✗', '✘', '✕', '❌', 'false', 'f', 'no', 'n', 'wrong', 'incorrect'])

function normalizePart(part: string, context: AnswerContext): string {
  let base = part.normalize('NFKC').trim()
    .replace(/^(?:最终)?答案\s*[:：]?\s*(?:[是为]\s*(?=\S))?/, '')
    .replace(/^[\s:：,，]+/, '')
  if (context.kind === undefined || /选择|单选|多选|判断/.test(context.kind)) {
    base = base.replace(/^\s*[A-Za-z][.、:：)）]\s*/, '')
  }
  base = base.trim()
  const key = base.replace(/[\s。.!！,，;；、]+$/g, '').toLowerCase()
  if (context.kind === undefined || /判断/.test(context.kind)) {
    if (JUDGE_TRUE.has(key)) return 'judge:true'
    if (JUDGE_FALSE.has(key)) return 'judge:false'
  }
  // Keep signs, decimal points, operators and internal punctuation: -1 != 1, 3.14 != 314.
  const clean = (context.kind === undefined ? base.replace(/[。！!]+$/g, '').replace(/(?<=[A-Za-z])\.$/, '') : base)
    .replace(/\s+/g, ' ').trim()
  return context.kind === undefined ? clean.toLowerCase() : clean
}

export function extractComparableAnswer(response: string, context: AnswerContext = {}): string {
  let answer = extractFinalAnswer(response, context)
  if (!answer) return ''
  if (isLongFormQuestion(context.kind)) return normalizePart(answer, context)
  if (context.options) answer = normalizeAnswerAgainstOptions(answer, context.options, context.kind)
  // Only multiple-choice answers are unordered. Blank positions and essay order matter.
  const unordered = context.kind === undefined || /多选/.test(context.kind)
  const parts = (unordered ? answer.split(/#+/) : answer.split('###')).map(part => normalizePart(part, context))
  if (unordered) parts.sort()
  return parts.join('###')
}

export function answersDisagree(responses: string[], context: AnswerContext = {}): boolean {
  const answers = responses.map(response => extractComparableAnswer(response, context)).filter(Boolean)
  return new Set(answers).size > 1
}

/** One stable winner, counting final answers rather than their accompanying explanations. */
export function mostFrequentAnswer<T extends { response: string }>(entries: T[], context: AnswerContext): T | undefined {
  const counts = new Map<string, { entry: T; count: number }>()
  for (const entry of entries) {
    const key = extractComparableAnswer(entry.response, context)
    if (!key) continue
    const group = counts.get(key)
    if (group) group.count++
    else counts.set(key, { entry, count: 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0]?.entry
}

export function finalAnswerJson(response: string, context: AnswerContext): string {
  const answer = normalizeAnswerAgainstOptions(extractFinalAnswer(response, context), context.options, context.kind)
  const key = extractComparableAnswer(response, context)
  // Synonyms still count as agreement for unknown types, but only real 判断题 have their wording rewritten.
  const judgement = /判断/.test(context.kind ?? '')
  return JSON.stringify({ answer: judgement && key === 'judge:true' ? '正确' : judgement && key === 'judge:false' ? '错误' : answer })
}
