import type { AIModel } from './modelConfig'

/** Self-contained: embedded into the existing user-visible protocol templates. */
export function applyModelRequestOptions(
  payload: Record<string, any>,
  config: Partial<AIModel> & { baseUrl?: string },
  kind: 'chat' | 'responses' | 'anthropic',
  thinking: { enable: boolean; effort: string; offResponsesEffort: string }
): void {
  const host = new URL(config.baseUrl || 'https://localhost').hostname
  const detected = host === 'api.openai.com' ? 'openai'
    : host === 'api.deepseek.com' ? 'deepseek'
    : host === 'dashscope.aliyuncs.com' || host.endsWith('.aliyuncs.com') ? 'qwen'
    : host === 'generativelanguage.googleapis.com' ? 'gemini'
    : host === 'openrouter.ai' ? 'openrouter'
    : host === 'api.groq.com' ? 'groq'
    : host === 'api.mistral.ai' ? 'mistral'
    : ['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.com'].includes(host) ? 'moonshot'
    : ['open.bigmodel.cn', 'api.z.ai'].includes(host) ? 'zhipu'
    : host.endsWith('.volces.com') ? 'volcengine'
    : ['api.siliconflow.cn', 'api.siliconflow.com'].includes(host) ? 'siliconflow'
    : host === 'api.x.ai' ? 'xai' : 'compatible'
  const upstream = config.upstream && config.upstream !== 'auto' ? config.upstream : detected
  const reasoningModel = /^(o[134](?:-|$)|gpt-5)/.test(payload.model || '')
  const effort = thinking.effort
  if (kind === 'chat') {
    for (const [key, name] of [['frequencyPenalty', 'frequency_penalty'], ['presencePenalty', 'presence_penalty'], ['seed', 'seed']] as const) {
      if (typeof config[key] === 'number') payload[name] = config[key]
    }
    if (config.stop?.length) payload.stop = config.stop
    if (upstream !== 'compatible') {
      delete payload.enable_thinking
      delete payload.thinking
      delete payload.reasoning_effort
    }
    if (upstream === 'openai') {
      if (thinking.enable && reasoningModel) payload.reasoning_effort = effort === 'max' ? 'high' : effort
      if (reasoningModel) {
        payload.max_completion_tokens = payload.max_tokens
        for (const name of ['max_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'stop']) delete payload[name]
      }
    }
    if (upstream === 'deepseek') {
      payload.thinking = { type: thinking.enable ? 'enabled' : 'disabled' }
      if (thinking.enable) {
        payload.reasoning_effort = effort === 'medium' ? 'high' : effort
        for (const name of ['temperature', 'presence_penalty', 'frequency_penalty']) delete payload[name]
        if (typeof payload.top_p === 'number') payload.top_p = Math.max(0.95, payload.top_p)
      }
    }
    if (upstream === 'qwen' || upstream === 'siliconflow') {
      if (!/^glm-5\.3(?:-|$)/i.test(payload.model) || thinking.enable) payload.enable_thinking = thinking.enable
      if (typeof config.topK === 'number') payload.top_k = config.topK
      if (thinking.enable && typeof config.thinkingBudget === 'number') payload.thinking_budget = config.thinkingBudget
    }
    if (upstream === 'volcengine') payload.thinking = { type: thinking.enable ? 'enabled' : 'disabled' }
    if (upstream === 'zhipu') {
      // GLM-5.3 always thinks; older GLM models can disable it.
      if (!/^glm-5\.3(?:-|$)/i.test(payload.model) || thinking.enable) payload.thinking = { type: thinking.enable ? 'enabled' : 'disabled' }
      if (thinking.enable && /^glm-5\.[23](?:-|$)/i.test(payload.model)) payload.reasoning_effort = effort === 'medium' ? 'high' : effort
    }
    if (upstream === 'moonshot') {
      if (/^kimi-k2\.[56](?:-|$)/.test(payload.model)) payload.thinking = { type: thinking.enable ? 'enabled' : 'disabled' }
      if (/^kimi-k3(?:-|$)/.test(payload.model) && thinking.enable) payload.reasoning_effort = effort === 'medium' ? 'high' : effort
      if (/^kimi-(k2\.[567]|k3)/.test(payload.model)) {
        delete payload.temperature
        delete payload.top_p
      }
    }
    if (upstream === 'gemini') {
      if (thinking.enable) payload.reasoning_effort = effort === 'max' ? 'high' : effort
      else if (/^gemini-2\.5-flash/.test(payload.model)) payload.reasoning_effort = 'none'
    }
    if (upstream === 'openrouter') payload.reasoning = thinking.enable ? { effort: effort === 'max' ? 'high' : effort } : { enabled: false }
    if (upstream === 'groq') {
      if (thinking.enable && /gpt-oss/.test(payload.model)) payload.reasoning_effort = effort === 'max' ? 'high' : effort
      if (payload.temperature === 0) payload.temperature = 1e-8
    }
    if (upstream === 'mistral' && typeof payload.seed === 'number') {
      payload.random_seed = payload.seed
      delete payload.seed
    }
    if (upstream === 'mistral' && thinking.enable) payload.reasoning_effort = effort === 'max' ? 'high' : effort
    if (upstream === 'xai' && /^grok-(?:3-mini|4)/.test(payload.model) && !payload.model.includes('non-reasoning')) {
      for (const name of ['presence_penalty', 'frequency_penalty', 'stop']) delete payload[name]
      if (thinking.enable && /^grok-(?:3-mini|4\.[567])/.test(payload.model)) payload.reasoning_effort = effort === 'max' ? 'high' : effort
    }
  }
  if (kind === 'responses') {
    if (typeof config.maxTokens === 'number') payload.max_output_tokens = config.maxTokens
    // Non-reasoning models reject reasoning entirely; disabled means use server defaults.
    if (!thinking.enable && upstream !== 'compatible') delete payload.reasoning
    if (thinking.enable && upstream === 'openai' && !reasoningModel) delete payload.reasoning
    if (payload.reasoning && upstream === 'openai' && effort === 'max') payload.reasoning.effort = 'high'
    if (upstream === 'deepseek') payload.reasoning = { effort: thinking.enable ? (effort === 'medium' ? 'high' : effort) : 'none' }
    if (upstream === 'volcengine') {
      delete payload.reasoning
      payload.thinking = { type: thinking.enable ? 'enabled' : 'disabled' }
    }
    if (!reasoningModel) {
      if (typeof config.temperature === 'number') payload.temperature = config.temperature
      if (typeof config.topP === 'number') payload.top_p = config.topP
    }
  }
  if (kind === 'anthropic') {
    delete payload.reasoning
    delete payload.thinking
    if (thinking.enable && !config.extraBody?.thinking) {
      const adaptive = config.thinkingMode === 'adaptive' || (config.thinkingMode !== 'budget' && /^claude-(?:(?:opus|sonnet)-4-[6-9]|(?:opus|sonnet)-5)/.test(payload.model))
      if (adaptive) {
        payload.thinking = { type: 'adaptive' }
        payload.output_config = { effort: effort === 'max' ? 'high' : effort }
      } else {
        const budget = config.thinkingBudget ?? 1024
        if (!Number.isInteger(budget) || budget < 1024 || budget >= payload.max_tokens) {
          throw new Error('Anthropic 思考预算必须至少为 1024 且小于最大输出 Token；自适应思考请用额外参数设置 thinking')
        }
        payload.thinking = { type: 'enabled', budget_tokens: budget }
      }
    }
    // Newer Claude models reject sampling controls; explicit overrides remain available below.
    if (config.stop?.length) payload.stop_sequences = config.stop
  }
  const model = payload.model
  const stream = payload.stream
  if (config.extraBody) Object.assign(payload, config.extraBody)
  for (const name of config.omitParameters || []) delete payload[name]
  // Input identity and streaming are owned by the caller (including Batch).
  payload.model = model
  payload.stream = stream
}
