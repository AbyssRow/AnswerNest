import * as XLSX from 'xlsx'

export interface ImportedQuestion {
  question: string
  options: string | null
  answer: string
  question_type: string
}

export function parseQuestionTable(content: string | Uint8Array): ImportedQuestion[] {
  const workbook = XLSX.read(content, {
    type: typeof content === 'string' ? 'string' : 'array',
    raw: true,
  })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) return []
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false })
  return rows.map(row => ({
    question: String(row['题目'] ?? ''),
    options: String(row['选项'] ?? '') || null,
    answer: String(row['答案'] ?? ''),
    question_type: String(row['类型'] ?? ''),
  })).filter(row => row.question.trim())
}
