import { isLongFormQuestion } from './answerNormalize'

export type AnswerFewShotKind = 'single' | 'multiple' | 'judgement' | 'completion' | 'general'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type FewShotPair = { user: string; assistant: string }

const SYSTEM_RULES = '你是专业答题助手。仅输出一个 JSON 对象：{"answer":"答案正文"}。'

const SINGLE_SHOTS: FewShotPair[] = [
  {
    user: `【题目类型：单选题】
【题目】
凸轮机构中，从动件运动规律取决于（ ）。
【选项】
A. 压力角
B. 传动角
C. 极力夹角

请作答，并在最后输出答案 JSON：`,
    assistant: '{"answer":"传动角"}',
  },
]

const MULTIPLE_SHOTS: FewShotPair[] = [
  {
    user: `【题目类型：多选题】
【题目】
下列属于输入设备的有（ ）。
【选项】
A. 键盘
B. 显示器
C. 鼠标
D. 打印机

请作答，并在最后输出答案 JSON：`,
    assistant: '{"answer":"键盘###鼠标"}',
  },
]

const JUDGEMENT_SHOTS: FewShotPair[] = [
  {
    user: `【题目类型：判断题】
【题目】
地球绕太阳公转一周约为 365 天。

请作答，并在最后输出答案 JSON：`,
    assistant: '{"answer":"正确"}',
  },
]

const COMPLETION_SHOTS: FewShotPair[] = [
  {
    user: `【题目类型：填空题】
【题目】
中国的首都是____，最大的城市是____。

请作答，并在最后输出答案 JSON：`,
    assistant: '{"answer":"北京###上海"}',
  },
]

const GENERAL_SHOTS: FewShotPair[] = [
  {
    user: `【题目类型：问答题】
【题目】
（1）简述光合作用的作用。（2）说明它与呼吸作用的关系。

请作答，并在最后输出答案 JSON：`,
    assistant: JSON.stringify({ answer: '（1）光合作用利用光能将二氧化碳和水转化为有机物，并释放氧气。\n（2）光合作用储存能量，呼吸作用分解有机物并释放能量；二者在物质和能量转化中相互联系。' }),
  },
]

export const detectAnswerFewShotKind = (query: string): AnswerFewShotKind => {
  const type = (query || '').match(/【题目类型(?:字段)?：([^】]+)】/)?.[1] || ''
  if (isLongFormQuestion(type)) return 'general'
  if (/多选/.test(type)) return 'multiple'
  if (/判断/.test(type)) return 'judgement'
  if (/填空/.test(type)) return 'completion'
  if (/单选|选择/.test(type)) return 'single'
  return 'general'
}

/** 是否为普通答题 prompt（排除同题判断 / URL 题等） */
export const shouldAttachAnswerFewShot = (query: string): boolean => {
  const q = (query || '').trim()
  if (!q) return false
  if (q.startsWith('__SAME_QUESTION_CHECK__:')) return false
  if (q.startsWith('__URL_QUESTION__:')) return false
  if (q.startsWith('你是一个总结专家')) return false
  return q.includes('【题目】') || q.includes('专业的答题助手') || q.includes('"answer"')
}

const shotsForKind = (kind: AnswerFewShotKind): FewShotPair[] => {
  switch (kind) {
    case 'single':
      return SINGLE_SHOTS
    case 'multiple':
      return MULTIPLE_SHOTS
    case 'judgement':
      return JUDGEMENT_SHOTS
    case 'completion':
      return COMPLETION_SHOTS
    default:
      return GENERAL_SHOTS
  }
}

/**
 * 构建带典型例题的多轮对话：
 * system 规则 → 例题 user/assistant 对 → 当前题目 user
 */
export const buildAnswerChatMessages = (query: string): ChatMessage[] => {
  if (!shouldAttachAnswerFewShot(query)) {
    return [{ role: 'user', content: query }]
  }

  const kind = detectAnswerFewShotKind(query)
  const shots = shotsForKind(kind)
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_RULES }]

  for (const shot of shots) {
    messages.push({ role: 'user', content: shot.user })
    messages.push({ role: 'assistant', content: shot.assistant })
  }
  messages.push({ role: 'user', content: query })
  return messages
}
