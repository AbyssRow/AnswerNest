import { answerContextFromPrompt, answersDisagree, extractComparableAnswer, finalAnswerJson, mostFrequentAnswer } from '../utils/answerConsensus'
import { buildSearchContextBlock, type WebSearchOutcome } from './webSearch'
import { isLongFormQuestion } from '../utils/answerNormalize'

export interface ModelAnswer<Model> {
  model: Model
  response: string
  success: boolean
}

export interface AnswerWorkflowResult<Model> {
  response: string
  success: boolean
  source?: ModelAnswer<Model>
  fromSummary: boolean
}

/** All answers finish -> consensus submits directly; disagreement searches, then summarizes. */
export async function runAnswerWorkflow<Model extends { displayName: string }>(options: {
  query: string
  answers: Promise<ModelAnswer<Model> | null>[]
  summaryModels: Model[]
  search?: () => Promise<WebSearchOutcome | null>
  summarize: (model: Model, query: string) => Promise<ModelAnswer<Model>>
  isCancelled: () => boolean
}): Promise<AnswerWorkflowResult<Model>> {
  const checkCancelled = () => {
    if (options.isCancelled()) throw new DOMException('请求已取消', 'AbortError')
  }
  const context = answerContextFromPrompt(options.query)
  const settled = await Promise.allSettled(options.answers)
  checkCancelled()
  const entries = settled.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
  const successful = entries.filter(entry => entry.success && extractComparableAnswer(entry.response, context))
  const baseWinner = mostFrequentAnswer(successful, context)
  const finish = (source: ModelAnswer<Model>, fromSummary: boolean): AnswerWorkflowResult<Model> =>
    ({ response: finalAnswerJson(source.response, context), success: true, source, fromSummary })

  if (!baseWinner) {
    const errors = entries.filter(entry => !entry.success).map(entry => `[${entry.model.displayName}] ${entry.response}`)
    return { response: `错误: ${errors.join('\n') || '未获得有效答案'}`, success: false, fromSummary: false }
  }
  if (!answersDisagree(successful.map(entry => entry.response), context) || !options.summaryModels.length) {
    return finish(baseWinner, false)
  }

  let search: WebSearchOutcome | null = null
  if (options.search) {
    try { search = await options.search() } catch { /* Search is optional; model answers remain available. */ }
    checkCancelled()
  }
  const searchSection = search?.ok ? `${buildSearchContextBlock(search.text)}\n\n` : ''
  const answerFormat = isLongFormQuestion(context.kind)
    ? '问答题按小问编号并保留完整段落，不用 ###。'
    : '选择题用选项正文，多选、多空用 ### 连接，填空按空位顺序，判断题用「正确」或「错误」。'
  const summaryQuery = `你是一个总结专家。核对原题、各模型回答及搜索资料，确定最终答案。

用户原始问题：
${options.query}

${searchSection}模型回答内容：
${successful.map(entry => `[${entry.model.displayName}]\n${entry.response}`).join('\n\n')}

仅输出 JSON：{"answer":"最终答案"}。${answerFormat}不含模型名和来源链接。`
  checkCancelled()
  const summaries = await Promise.allSettled(options.summaryModels.map(model => options.summarize(model, summaryQuery)))
  checkCancelled()
  const successfulSummaries = summaries.flatMap(result =>
    result.status === 'fulfilled' && result.value.success ? [result.value] : [])
  const summaryWinner = mostFrequentAnswer(successfulSummaries, context)
  return summaryWinner ? finish(summaryWinner, true) : finish(baseWinner, false)
}
