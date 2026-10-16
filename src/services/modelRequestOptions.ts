import type { AIModel } from './modelConfig'

/** Self-contained: embedded into the existing user-visible protocol templates. */
export function applyModelRequestOptions(
  payload: Record<string, any>,
  // searchEnabled 是调用方（总结阶段）临时打开的；模型上保存的 webSearch 只是「允许」，不能直接当作每次请求都联网
  config: Partial<AIModel> & { baseUrl?: string; searchEnabled?: boolean },
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
  // 中转站常带前缀（openai/gpt-5、anthropic/claude-...），按去掉前缀后的模型名判断官方参数规则
  const bareId = String(payload.model || '').toLowerCase().replace(/^.*\//, '')
  const reasoningModel = /^(o[134](?:-|$)|gpt-[56])/.test(bareId)
  // 老 GPT 不是推理模型，不接受 reasoning / reasoning_effort
  const plainGpt = /^(gpt-[34]|chatgpt)/.test(bareId)
  const claudeId = /^claude-/.test(bareId)
  // Claude 4.6 及之后的模型不再接受自定义采样参数（Haiku 5.5：temperature 只能是 1、top_p 只能是 0.99、top_k 一律拒绝）；
  // 老 Claude 可以用 temperature，但 temperature 和 top_p 不能同时出现
  const claudeNoSampling = claudeId && !/^claude-(?:3|opus-4(?!-[6-9])|sonnet-4(?!-[6-9])|haiku-4)/.test(bareId)
  const effort = thinking.effort
  // GPT-6 可以接受 max；更早的 OpenAI 推理模型最高到 high
  const openaiEffort = /^gpt-6/.test(payload.model || '') ? effort : effort === 'max' ? 'high' : effort
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
    if (upstream === 'compatible') {
      // 通用 OpenAI 兼容服务（中转站）：按模型名套用官方规则。Qwen 风格的开关不属于 OpenAI / Claude 模型。
      if (reasoningModel || plainGpt || claudeId) { delete payload.enable_thinking; delete payload.thinking }
      if (plainGpt) delete payload.reasoning_effort
      if (claudeId) {
        delete payload.top_p
        if (claudeNoSampling) delete payload.temperature
      }
    }
    if (upstream === 'openai' || (upstream === 'compatible' && reasoningModel)) {
      if (thinking.enable && reasoningModel) payload.reasoning_effort = openaiEffort
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
    // 联网搜索：OpenRouter 的 web 插件由服务端搜索并把结果并入回答。模型名已带 :online 时它自己就会搜，不重复加。
    if (upstream === 'openrouter' && config.searchEnabled === true && !/:online$/i.test(String(payload.model || ''))) {
      const plugins = Array.isArray(payload.plugins) ? payload.plugins : []
      if (!plugins.some((plugin: any) => plugin && plugin.id === 'web')) {
        payload.plugins = [
          ...plugins,
          {
            id: 'web',
            max_results: 5,
            // 默认的搜索提示会要求模型把来源写成链接；这里只拿搜索结果核对答案，最终答案里不要链接和来源
            search_prompt: '以下是联网搜索到的参考资料，只用来核对答案是否正确。最终答案里不要出现链接、引用编号或来源说明。',
          },
        ]
      }
    }
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
    // GPT-6 不接受 none/minimal（Sol 两者都不接受），关闭思考时不能发 reasoning，否则整个请求 400
    if (!thinking.enable && (upstream !== 'compatible' || /gpt-6/.test(payload.model || ''))) delete payload.reasoning
    if (thinking.enable && upstream === 'openai' && !reasoningModel) delete payload.reasoning
    if (payload.reasoning && upstream === 'openai') payload.reasoning.effort = openaiEffort
    if (plainGpt) delete payload.reasoning
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
    if (!config.extraBody?.thinking) {
      // 去掉网关前缀（如 anthropic/claude-opus-5-5）再判断
      const id = String(payload.model || '').toLowerCase().replace(/^.*\//, '')
      const isClaude = /^claude-/.test(id)
      // 只支持手动预算（type: enabled + budget_tokens）的老模型；4.7 及之后的模型直接拒绝 enabled
      const extendedOnly = /^claude-(?:3|opus-4(?!-[6-9])|sonnet-4(?!-[6-9])|haiku-4)/.test(id)
      // 关不掉的模型：发 disabled 会 400，只能不发 thinking
      // 下面几类默认就开着思考，关闭时才需要显式声明
      const sonnet55 = /^claude-sonnet-5-5(?:-|$)/.test(id)
      const disabledOk = /^claude-(?:opus|sonnet)-5(?!-5(?:-|$))/.test(id) || /^claude-haiku-5-5/.test(id)
      if (!thinking.enable) {
        if (sonnet55) payload.thinking = { type: 'between_tools' }
        else if (disabledOk) payload.thinking = { type: 'disabled' }
      } else {
        // 自动：Claude 新模型用自适应；老 Claude 用固定预算；非 Claude（DeepSeek、Kimi 的 Anthropic 兼容端点等）保持固定预算
        const adaptive = config.thinkingMode === 'adaptive' || (config.thinkingMode !== 'budget' && isClaude && !extendedOnly)
        if (adaptive) {
          payload.thinking = { type: 'adaptive' }
          payload.output_config = { effort }
        } else {
          const budget = config.thinkingBudget ?? 1024
          if (!Number.isInteger(budget) || budget < 1024 || budget >= payload.max_tokens) {
            throw new Error('Anthropic 思考预算必须至少为 1024 且小于最大输出 Token；自适应思考请用额外参数设置 thinking')
          }
          payload.thinking = { type: 'enabled', budget_tokens: budget }
        }
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
