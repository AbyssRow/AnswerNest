<template>
  <div class="general-settings">
    <div class="network-group configuration-transfer">
      <div class="group-title">配置导入导出</div>
      <div class="setting-item">
        <div class="setting-info">
          <h3 class="setting-title">迁移到另一台电脑</h3>
          <p class="setting-description">包含所有平台与模型、模型选择、API Key、代理、搜索服务和常规设置。文件含明文密钥，请妥善保管。不包含题库、窗口位置和题库保存文件夹。</p>
        </div>
        <div class="setting-control transfer-actions">
          <button class="folder-action-btn select-folder-btn" :disabled="transferBusy" @click="exportConfigFile">导出配置</button>
          <button class="folder-action-btn select-folder-btn" :disabled="transferBusy" @click="configFileInput?.click()">导入配置</button>
          <input ref="configFileInput" type="file" accept=".json,application/json" hidden :disabled="transferBusy" @change="previewConfigFile" />
        </div>
      </div>
      <div v-if="pendingConfig" class="transfer-preview">
        <p>{{ pendingConfigName }}：{{ pendingConfig.models.platforms.length }} 个平台、{{ pendingConfig.models.platforms.reduce((count, platform) => count + platform.models.length, 0) }} 个模型。</p>
        <p>确认后覆盖文件中的模型、搜索和常规设置，本机题库保持不变。若题库服务正在运行，导入后请停止并重新启动服务。</p>
        <div class="transfer-actions">
          <button class="folder-action-btn select-folder-btn" :disabled="transferBusy" @click="confirmConfigImport">{{ transferBusy ? '保存中…' : '确认导入' }}</button>
          <button class="folder-action-btn" :disabled="transferBusy" @click="pendingConfig = null; transferNotice = '已取消导入'">取消</button>
        </div>
      </div>
      <p v-if="transferNotice" class="setting-description transfer-notice" :class="{ 'ws-test-error': transferFailed }" role="status">{{ transferNotice }}</p>
    </div>
    <div class="network-group">
      <div class="group-title">显示设置</div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">主题模式</h3>
        <p class="setting-description">选择您偏好的界面主题</p>
      </div>
      <div class="setting-control">
        <ThemeSwitch v-model="localSettings.theme" @update:modelValue="handleThemeChange" />
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">关闭窗口时最小化到托盘</h3>
        <p class="setting-description">开启后，点关闭按钮只会隐藏窗口，题库服务继续在后台运行；从托盘图标可以重新打开或退出。关闭则点关闭按钮直接退出程序。</p>
      </div>
      <div class="setting-control">
        <Toggle v-model="settings.closeToTray" variant="default" size="medium"
          @change="handleSettingChange('closeToTray', $event)" />
      </div>
    </div>
    </div>

    <div class="network-group">
      <div class="group-title">保存设置</div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">缓存文件夹</h3>
        <p class="setting-description">打开应用缓存目录，可手动清理缓存文件</p>
      </div>
      <div class="setting-control">
        <button 
          ref="btnRef"
          class="folder-action-btn select-folder-btn"
          :class="{ 'btn-ripple': isAnimating }"
          @click="handleButtonClick"
        >
          <svg t="1774430153065" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
            <path d="M418.688 133.333333a122.666667 122.666667 0 0 1 93.013333 42.666667H785.066667a186.666667 186.666667 0 0 1 186.581333 181.162667l0.085333 5.504v17.92h-0.256c0.170667 1.429333 0.256 2.88 0.256 4.373333V789.333333a186.666667 186.666667 0 0 1-186.666666 186.666667H238.933333A186.666667 186.666667 0 0 1 52.266667 789.333333V320a186.666667 186.666667 0 0 1 186.666666-186.666667z m0 74.666667H238.933333A112 112 0 0 0 126.933333 320v469.333333c0 61.866667 50.133333 112 112 112h546.133334c61.866667 0 112-50.133333 112-112V422.272H615.04a122.666667 122.666667 0 0 1-113.834667-76.992l-1.834666-4.842667-35.413334-100.416a48 48 0 0 0-45.269333-32.021333zM448 688a37.333333 37.333333 0 0 1 3.072 74.538667L448 762.666667h-170.666667a37.333333 37.333333 0 0 1-3.072-74.538667L277.333333 688h170.666667z m337.066667-437.333333H546.88l22.912 64.917333a48 48 0 0 0 41.685333 31.914667l3.562667 0.128 281.024-0.021334a112.021333 112.021333 0 0 0-106.389333-96.853333l-4.608-0.085333z" fill="currentColor"/>
          </svg>
          打开文件夹
        </button>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">题目保存文件夹</h3>
        <p class="setting-description">
          AI返回答案的题目将保存至：
          <button
            v-if="settings.questionSaveDir"
            type="button"
            class="selected-folder-link"
            :disabled="!canOpenQuestionSaveFolder"
            @click="openQuestionSaveFolder"
          >
            {{ settings.questionSaveDir }}
          </button>
          <span v-else class="unset-hint">默认文件夹</span>
        </p>

      </div>
      <div class="setting-control">
        <button class="folder-action-btn select-folder-btn" @click="selectQuestionSaveDir">
          <svg t="1774430153065" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
            <path d="M418.688 133.333333a122.666667 122.666667 0 0 1 93.013333 42.666667H785.066667a186.666667 186.666667 0 0 1 186.581333 181.162667l0.085333 5.504v17.92h-0.256c0.170667 1.429333 0.256 2.88 0.256 4.373333V789.333333a186.666667 186.666667 0 0 1-186.666666 186.666667H238.933333A186.666667 186.666667 0 0 1 52.266667 789.333333V320a186.666667 186.666667 0 0 1 186.666666-186.666667z m0 74.666667H238.933333A112 112 0 0 0 126.933333 320v469.333333c0 61.866667 50.133333 112 112 112h546.133334c61.866667 0 112-50.133333 112-112V422.272H615.04a122.666667 122.666667 0 0 1-113.834667-76.992l-1.834666-4.842667-35.413334-100.416a48 48 0 0 0-45.269333-32.021333zM448 688a37.333333 37.333333 0 0 1 3.072 74.538667L448 762.666667h-170.666667a37.333333 37.333333 0 0 1-3.072-74.538667L277.333333 688h170.666667z m337.066667-437.333333H546.88l22.912 64.917333a48 48 0 0 0 41.685333 31.914667l3.562667 0.128 281.024-0.021334a112.021333 112.021333 0 0 0-106.389333-96.853333l-4.608-0.085333z" fill="currentColor"/>
          </svg>
          选择文件夹
        </button>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">AI回答添加到本地题库</h3>
        <p class="setting-description">开启后，AI 新答出的题目会写入本地题库；关闭则只返回答案，不入库。</p>
      </div>
      <div class="setting-control">
        <Toggle v-model="settings.autoAddToQuestionBank" variant="default" size="medium"
          @change="handleSettingChange('autoAddToQuestionBank', $event)" />
      </div>
    </div>
    </div>

    <div class="network-group">
      <div class="group-title">AI设置</div>
    <div class="setting-item">

      <div class="setting-info">
        <h3 class="setting-title">模型最长响应时间</h3>
        <p class="setting-description">AI 模型单次请求超时（秒）。超时后可按「失败自动重试次数」重试；整题等待覆盖答题、搜索、总结和附件读取。默认 40 秒。</p>
      </div>
      <div class="setting-control timeout-control">
        <input
          type="number"
          class="form-input"
          :value="settings.modelResponseTimeout ?? 40"
          min="5"
          max="600"
          step="5"
          @change="handleSettingChange('modelResponseTimeout', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="timeout-unit">秒</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">失败自动重试次数</h3>
        <p class="setting-description">仅在「只有一个基础模型」、总结模型失败、或视觉模型调用失败时自动重试。0 表示不重试，默认 2 次。</p>
      </div>
      <div class="setting-control timeout-control">
        <input
          type="number"
          class="form-input"
          :value="settings.modelRetryCount ?? 2"
          min="0"
          max="10"
          step="1"
          @change="handleSettingChange('modelRetryCount', Math.max(0, Math.min(10, Number(($event.target as HTMLInputElement).value) || 0)))"
        />
        <span class="timeout-unit">次</span>
      </div>
    </div>
    </div>

    <div class="network-group web-search-group">
      <div class="group-title">联网搜索（总结时）</div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">总结时联网搜索</h3>
        <p class="setting-description">所有答题模型完成后，答案一致直接提交；答案不一致时，先搜索一次，再把各模型回答和搜索资料一起交给总结模型。需要选择总结模型并填写搜索 Key。搜索资料显示在日志里；带图片的题不搜索，搜索失败则仅依据模型回答总结。</p>
      </div>
      <div class="setting-control">
        <Toggle v-model="settings.webSearch.enabled" variant="default" size="medium" />
      </div>
    </div>
    <template v-if="settings.webSearch.enabled">
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索服务</h3>
        <p class="setting-description">各服务的 Key、服务地址和代理分别保存在本机，切换时自动恢复。下方仅显示当前搜索服务的专属参数。<a :href="webSearchKeyUrl" @click.prevent="openWebSearchUrl(webSearchKeyUrl)">获取 API Key</a></p>
      </div>
      <div class="setting-control">
        <select class="form-input ws-select" :value="settings.webSearch.provider" @change="changeWebSearchProvider(($event.target as HTMLSelectElement).value as WebSearchProvider)">
          <option v-for="p in WEB_SEARCH_PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">API Key</h3>
      </div>
      <div class="setting-control">
        <input type="password" class="form-input ws-wide" autocomplete="off" spellcheck="false"
          :value="settings.webSearch.apiKey" placeholder="填写搜索服务的 API Key"
          @change="settings.webSearch.apiKey = ($event.target as HTMLInputElement).value.trim()" />
      </div>
    </div>
    <template v-if="settings.webSearch.provider === 'exa'">
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">Exa 搜索强度</h3>
        <p class="setting-description">{{ exaSearchMode.description }} 计费以<a href="https://exa.ai/pricing" @click.prevent="openWebSearchUrl('https://exa.ai/pricing')">官方价格</a>为准。</p>
      </div>
      <div class="setting-control">
        <select class="form-input ws-select" aria-label="Exa 搜索强度" :value="settings.webSearch.exaType" @change="settings.webSearch.exaType = ($event.target as HTMLSelectElement).value as ExaSearchType">
          <option v-for="mode in EXA_SEARCH_MODES" :key="mode.id" :value="mode.id">{{ mode.label }}</option>
        </select>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">Exa 返回内容</h3>
        <p class="setting-description">摘录：只返回和搜索词相关的片段，减少总结模型的输入；全文：返回网页正文开头部分。两者都按「每条结果最多字数」限制长度。</p>
      </div>
      <div class="setting-control">
        <select class="form-input ws-select" aria-label="Exa 返回内容" :value="settings.webSearch.exaContent" @change="settings.webSearch.exaContent = ($event.target as HTMLSelectElement).value as 'highlights' | 'text'">
          <option value="highlights">摘录</option>
          <option value="text">全文</option>
        </select>
      </div>
    </div>
    </template>
    <div v-if="settings.webSearch.provider === 'firecrawl'" class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">Firecrawl 抓取网页正文</h3>
        <p class="setting-description">开启后会抓取搜索结果的网页正文，内容更全，也会增加积分消耗；关闭则只用搜索结果自带的摘要。</p>
      </div>
      <div class="setting-control">
        <Toggle v-model="settings.webSearch.firecrawlScrape" variant="default" size="medium" />
      </div>
    </div>
    <div v-if="settings.webSearch.provider === 'deepseek'" class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">DeepSeek 返回内容</h3>
        <p class="setting-description">摘要：使用接口给模型准备的摘要；正文：额外返回网页正文，再按「每条结果最多字数」截断。DeepSeek 的搜索词最多 128 字，更长的题目会被截断。</p>
      </div>
      <div class="setting-control">
        <select class="form-input ws-select" aria-label="DeepSeek 返回内容" :value="settings.webSearch.deepseekContent" @change="settings.webSearch.deepseekContent = ($event.target as HTMLSelectElement).value as 'summary' | 'content'">
          <option value="summary">摘要</option>
          <option value="content">正文</option>
        </select>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索条数</h3>
        <p class="setting-description">每次搜索取几条结果（1–10），默认 3。条数越多，给总结模型的资料越长；实际费用取决于搜索服务、模式和是否抓取正文。</p>
      </div>
      <div class="setting-control timeout-control">
        <input type="number" class="form-input" min="1" max="10" step="1" :value="settings.webSearch.maxResults"
          @change="setWebSearchNumber('maxResults', $event, 1, 10)" />
        <span class="timeout-unit">条</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索词是否带选项</h3>
        <p class="setting-description">搜索词始终以题目为主。「自动」表示题目不足 12 个字（比如“下列说法正确的是”）时才补上选项，避免只搜题干搜不到东西。</p>
      </div>
      <div class="setting-control">
        <select class="form-input ws-select" :value="settings.webSearch.optionsMode" @change="settings.webSearch.optionsMode = ($event.target as HTMLSelectElement).value as 'never' | 'auto' | 'always'">
          <option value="never">不带选项</option>
          <option value="auto">自动</option>
          <option value="always">总是带选项</option>
        </select>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">每条结果最多字数</h3>
        <p class="setting-description">超过的部分会被截掉。默认 2000。</p>
      </div>
      <div class="setting-control timeout-control">
        <input type="number" class="form-input" min="200" max="10000" step="100" :value="settings.webSearch.maxCharsPerResult"
          @change="setWebSearchNumber('maxCharsPerResult', $event, 200, 10000)" />
        <span class="timeout-unit">字</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索超时</h3>
        <p class="setting-description">超过这个时间就放弃搜索，不带资料继续总结。默认 20 秒；OCS 默认 60 秒超时，要留出总结的时间。</p>
      </div>
      <div class="setting-control timeout-control">
        <input type="number" class="form-input" min="3" max="120" step="1" :value="settings.webSearch.timeoutSec"
          @change="setWebSearchNumber('timeoutSec', $event, 3, 120)" />
        <span class="timeout-unit">秒</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索词最长字数</h3>
        <p class="setting-description">题目（和选项）太长时截断，默认 300。{{ settings.webSearch.provider === 'deepseek' ? 'DeepSeek 接口最多接受 128 字（含域名过滤），超出会进一步截断。' : '' }}</p>
      </div>
      <div class="setting-control timeout-control">
        <input type="number" class="form-input" min="20" max="500" step="10" :value="settings.webSearch.maxQueryChars"
          @change="setWebSearchNumber('maxQueryChars', $event, 20, 500)" />
        <span class="timeout-unit">字</span>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">只搜这些网站</h3>
        <p class="setting-description">域名用逗号或换行分隔，例如 zhihu.com, baike.baidu.com。留空不限制。</p>
      </div>
      <div class="setting-control">
        <input type="text" class="form-input ws-wide" :value="settings.webSearch.includeDomains" placeholder="可留空"
          @change="settings.webSearch.includeDomains = ($event.target as HTMLInputElement).value.trim()" />
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">不搜这些网站</h3>
        <p class="setting-description">格式同上。{{ webSearchDomainHint }}</p>
      </div>
      <div class="setting-control">
        <input type="text" class="form-input ws-wide" :value="settings.webSearch.excludeDomains" placeholder="可留空"
          @change="settings.webSearch.excludeDomains = ($event.target as HTMLInputElement).value.trim()" />
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">服务地址</h3>
        <p class="setting-description">留空使用 {{ webSearchProvider.baseUrl }}。{{ settings.webSearch.provider === 'firecrawl' ? '自建服务或中转时填写对应地址。' : '使用中转时填写对应地址。' }}</p>
      </div>
      <div class="setting-control">
        <input type="text" class="form-input ws-wide" :value="settings.webSearch.baseUrl" placeholder="留空使用官方地址"
          @change="settings.webSearch.baseUrl = ($event.target as HTMLInputElement).value.trim()" />
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">搜索代理</h3>
        <p class="setting-description">访问搜索服务要走代理时填写，支持 HTTP / HTTPS / SOCKS5，例如 http://127.0.0.1:7890。留空直连。</p>
      </div>
      <div class="setting-control">
        <input type="text" class="form-input ws-wide" :value="settings.webSearch.proxyUrl" placeholder="留空直连"
          @change="settings.webSearch.proxyUrl = ($event.target as HTMLInputElement).value.trim()" />
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">测试搜索</h3>
        <p class="setting-description ws-test-result" :class="{ 'ws-test-error': webSearchTest.startsWith('错误') }" role="status">{{ webSearchTest || '用当前设置搜一次“中国的首都是哪个城市”，检查 Key 和网络是否可用（会消耗一次搜索额度）。' }}</p>
      </div>
      <div class="setting-control">
        <button class="folder-action-btn select-folder-btn" :disabled="webSearchTesting" @click="testWebSearch">
          {{ webSearchTesting ? '搜索中…' : '测试' }}
        </button>
      </div>
    </div>
    </template>
    </div>

    <div class="network-group">
      <div class="group-title">网络设置</div>
    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">服务器端口</h3>
        <p class="setting-description">设置本地服务器监听的端口号</p>
      </div>
      <div class="setting-control">
        <div class="input-group">
          <input
            type="number"
            v-model="settings.network.serverPort"
            @change="handleNetworkChange"
            min="1"
            max="65535"
            class="form-input"
            placeholder="3000"
          />
          <span class="input-suffix">端口</span>
        </div>
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <div class="setting-title-with-help">
          <h3 class="setting-title">局域网访问</h3>
          <button class="help-button" @click="openLanAccessDocs" title="查看局域网访问文档">
            <svg width="14" height="14" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path d="M463.99957 784.352211c0 26.509985 21.490445 48.00043 48.00043 48.00043s48.00043-21.490445 48.00043-48.00043c0-26.509985-21.490445-48.00043-48.00043-48.00043S463.99957 757.842226 463.99957 784.352211z" fill="currentColor"></path>
              <path d="M512 960c-247.039484 0-448-200.960516-448-448S264.960516 64 512 64 960 264.960516 960 512 759.039484 960 512 960zM512 128.287273c-211.584464 0-383.712727 172.128262-383.712727 383.712727 0 211.551781 172.128262 383.712727 383.712727 383.712727 211.551781 0 383.712727-172.159226 383.712727-383.712727C895.712727 300.415536 723.551781 128.287273 512 128.287273z" fill="currentColor"></path>
              <path d="M512 673.695256c-17.664722 0-32.00086-14.336138-32.00086-31.99914l0-54.112297c0-52.352533 39.999785-92.352318 75.32751-127.647359 25.887273-25.919957 52.67249-52.67249 52.67249-74.016718 0-53.343368-43.07206-96.735385-95.99914-96.735385-53.823303 0-95.99914 41.535923-95.99914 94.559333 0 17.664722-14.336138 31.99914-32.00086 31.99914s-32.00086-14.336138-32.00086-31.99914c0-87.423948 71.775299-158.559333 160.00086-158.559333s160.00086 72.095256 160.00086 160.735385c0 47.904099-36.32028 84.191695-71.424378 119.295794-27.839699 27.776052-56.575622 56.511974-56.575622 82.3356l0 54.112297C544.00086 659.328155 529.664722 673.695256 512 673.695256z" fill="currentColor"></path>
            </svg>
          </button>
        </div>
        <p class="setting-description">允许局域网内其他设备访问本地服务器</p>
      </div>
      <div class="setting-control">
        <Toggle
          v-model="settings.network.enableLanAccess"
          variant="default"
          size="medium"
          @change="handleNetworkChange"
        />
      </div>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <h3 class="setting-title">绑定地址</h3>
        <p class="setting-description">服务器绑定的IP地址（自动根据局域网访问设置调整）</p>
      </div>
      <div class="setting-control">
        <div class="readonly-value">
          {{ settings.network.bindAddress }}
        </div>
      </div>
    </div>
    </div>
  </div>

  <FolderPickerDialog
    :visible="showFolderPicker"
    :initial-folder-id="settings.questionSaveFolderId"
    @cancel="showFolderPicker = false"
    @confirm="handleFolderConfirm"
  />
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'

import { useSettingsManager } from '../../composables/useSettingsManager'

import { useTheme } from '../../composables/useTheme'
import { environmentDetector } from '../../services/environmentDetector'
import { EXA_SEARCH_MODES, WEB_SEARCH_PROVIDERS, normalizeWebSearchConfig, runWebSearch, switchWebSearchProvider, type ExaSearchType, type WebSearchProvider } from '../../services/webSearch'
import { CONFIGURATION_MAX_BYTES, exportConfiguration, importConfiguration, parseConfigurationBackup, type ConfigurationBackup } from '../../services/configurationBackup'
import { version as appVersion } from '../../../package.json'
import ThemeSwitch from './GeneralSettings/ThemeSwitch.vue'
import Toggle from '../../components/Toggle.vue'
import FolderPickerDialog from '../../components/FolderPickerDialog.vue'

const emit = defineEmits<{
  'open-question-folder': [folderId: number]
}>()

const configFileInput = ref<HTMLInputElement | null>(null)
const transferBusy = ref(false)
const transferFailed = ref(false)
const transferNotice = ref('')
const pendingConfig = ref<ConfigurationBackup | null>(null)
const pendingConfigName = ref('')

const exportConfigFile = async () => {
  transferBusy.value = true
  transferFailed.value = false
  transferNotice.value = ''
  try {
    const content = await exportConfiguration(appVersion)
    const filename = `AnswerNest-config-${new Date().toISOString().slice(0, 10)}.json`
    if (environmentDetector.isTauriEnvironment()) {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const path = await save({ title: '导出 AnswerNest 配置', defaultPath: filename, filters: [{ name: 'JSON 配置', extensions: ['json'] }] })
      if (!path) return
      const { writeFile } = await import('@tauri-apps/plugin-fs')
      await writeFile(path, new TextEncoder().encode(content))
    } else {
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    transferNotice.value = '配置已导出，可在另一台电脑的「导入配置」中恢复。'
  } catch (error) {
    transferFailed.value = true
    transferNotice.value = `导出失败：${error instanceof Error ? error.message : String(error)}`
  } finally { transferBusy.value = false }
}

const previewConfigFile = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  pendingConfig.value = null
  transferNotice.value = ''
  transferFailed.value = false
  transferBusy.value = true
  try {
    if (file.size > CONFIGURATION_MAX_BYTES) throw new Error('配置文件不能超过 10 MB')
    pendingConfig.value = parseConfigurationBackup(await file.text())
    pendingConfigName.value = file.name
  } catch (error) {
    transferFailed.value = true
    transferNotice.value = error instanceof Error ? error.message : String(error)
  } finally { transferBusy.value = false }
}

const confirmConfigImport = async () => {
  if (!pendingConfig.value || transferBusy.value) return
  transferBusy.value = true
  transferFailed.value = false
  transferNotice.value = ''
  try {
    await importConfiguration(pendingConfig.value)
    syncLocalSettings()
    await setTheme(settings.value.theme)
    webSearchTest.value = ''
    pendingConfig.value = null
    transferNotice.value = '配置已导入并保存，模型和搜索设置已生效。若题库服务正在运行，请停止并重新启动服务。'
  } catch (error) {
    transferFailed.value = true
    transferNotice.value = error instanceof Error ? error.message : String(error)
  } finally { transferBusy.value = false }
}

// 打开缓存文件夹
const openingCache = ref(false)

const isAnimating = ref(false)
const isCooldown = ref(false)

const btnRef = ref<HTMLElement | null>(null)
let animationTimer: any = null
const handleButtonClick = () => {
  // 1. 每次点击都会强制重新触发视觉动画
  if (animationTimer) clearTimeout(animationTimer)
  
  // 核心逻辑：先取消类名，强制重绘，再重新添加类名
  isAnimating.value = false
  
  if (btnRef.value) {
    // 强制引发重排 (Reflow)，确保浏览器感知到 class 的移除
    void btnRef.value.offsetWidth
  }
  
  // 使用 requestAnimationFrame 确保在下一次重绘时添加类名
  requestAnimationFrame(() => {
    isAnimating.value = true
    animationTimer = setTimeout(() => {
      isAnimating.value = false
      animationTimer = null
    }, 600)
  })

  // 2. 只有在冷却结束后才会再次触发实际逻辑
  if (isCooldown.value || openingCache.value) return
  
  isCooldown.value = true
  setTimeout(() => {
    isCooldown.value = false
  }, 5000)

  openCacheFolder()
}

// 打开处理函数
let invoke: any = null

const openCacheFolder = async () => {
  openingCache.value = true
  try {
    if (!invoke) {
      const core = await import('@tauri-apps/api/core')
      invoke = core.invoke
    }
    await invoke('open_cache_dir')
  } catch (e) {
    console.error('打开缓存文件夹失败:', e)
  } finally {
    openingCache.value = false
  }
}
// 设置管理
const { settings, saveSettings, setSetting } = useSettingsManager()
const canOpenQuestionSaveFolder = computed(() => settings.value.questionSaveFolderId !== null && settings.value.questionSaveFolderId !== undefined)


const handleSettingChange = (key: keyof import('../../services/settings').AppSettings, value: any) => {
  setSetting(key, value)
}


// 联网搜索
const webSearchTest = ref('')
const webSearchTesting = ref(false)
const webSearchProvider = computed(() => WEB_SEARCH_PROVIDERS.find(provider => provider.id === settings.value.webSearch.provider) || WEB_SEARCH_PROVIDERS[0])
const exaSearchMode = computed(() => EXA_SEARCH_MODES.find(mode => mode.id === settings.value.webSearch.exaType) || EXA_SEARCH_MODES.find(mode => mode.id === 'auto')!)
const webSearchDomainHint = computed(() => {
  if (settings.value.webSearch.provider === 'firecrawl') return '“只搜”和“不搜”不能同时用，同时填了优先使用“只搜”。'
  if (settings.value.webSearch.provider === 'deepseek') return '域名会转换成 site: / -site: 搜索语法，和题目一起不超过 128 字；域名太多、题目剩余空间不足时不过滤。'
  return '可以同时限定搜索网站和排除网站。'
})
const changeWebSearchProvider = (provider: WebSearchProvider) => {
  settings.value.webSearch = switchWebSearchProvider(settings.value.webSearch, provider)
  webSearchTest.value = ''
}
const webSearchKeyUrl = computed(() => webSearchProvider.value.keyUrl)
const openWebSearchUrl = async (url: string) => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    window.open(url, '_blank')
  }
}
const setWebSearchNumber =(key: 'maxResults' | 'maxCharsPerResult' | 'timeoutSec' | 'maxQueryChars', event: Event, min: number, max: number) => {
  const input = event.target as HTMLInputElement
  const n = Math.floor(Number(input.value))
  const value = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : settings.value.webSearch[key]
  settings.value.webSearch[key] = value
  input.value = String(value)
}
const testWebSearch = async () => {
  webSearchTesting.value = true
  webSearchTest.value = ''
  try {
    const config = normalizeWebSearchConfig(settings.value.webSearch)
    if (!config.apiKey) { webSearchTest.value = '错误: 请先填写 API Key'; return }
    const outcome = await runWebSearch(config, '【题目】\n中国的首都是哪个城市\n\n请作答')
    webSearchTest.value = outcome.ok
      ? `可用：搜到 ${outcome.items.length} 条，耗时 ${(outcome.tookMs / 1000).toFixed(1)} 秒。第一条：${outcome.items[0].title || outcome.items[0].url}`
      : outcome.text
  } catch (error) {
    webSearchTest.value = `错误: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    webSearchTesting.value = false
  }
}

const showFolderPicker = ref(false)

const selectQuestionSaveDir = () => {
  showFolderPicker.value = true
}

const openQuestionSaveFolder = () => {
  const folderId = settings.value.questionSaveFolderId
  if (folderId === null || folderId === undefined) return
  emit('open-question-folder', folderId)
}

const handleFolderConfirm = async (folderId: number, folderName: string, folderPath: string) => {

  showFolderPicker.value = false
  setSetting('questionSaveDir', folderPath || folderName)
  setSetting('questionSaveFolderId', folderId)
  await saveSettings()
}

const handleNetworkChange = () => {
  settings.value.network.bindAddress = settings.value.network.enableLanAccess ? '0.0.0.0' : '127.0.0.1'
}

const openLanAccessDocs = async () => {
  const url = 'https://github.com/AbyssRow/AnswerNest#局域网访问'
  if (environmentDetector.isTauriEnvironment) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } catch (error) {
      window.open(url, '_blank')
    }
  } else {
    window.open(url, '_blank')
  }
}

// 主题管理
const { setTheme } = useTheme()

// 本地设置状态
const localSettings = ref({
  theme: 'auto' as 'light' | 'dark' | 'auto'
})

// 处理主题变更
const handleThemeChange = async (theme: 'light' | 'dark' | 'auto') => {
  localSettings.value.theme = theme
  setSetting('theme', theme)
  await setTheme(theme)
  await saveSettings()
}

// 同步本地设置
const syncLocalSettings = () => {
  localSettings.value = {
    theme: settings.value.theme || 'auto'
  }
}

onMounted(() => {
  syncLocalSettings()
})
</script>

<style scoped>
.transfer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.configuration-transfer .setting-item {
  flex-wrap: wrap;
  gap: 12px;
}

.transfer-preview {
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.transfer-preview p { margin: 0 0 10px; line-height: 1.6; }
.transfer-notice { margin-top: 12px; }

.setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 18px 0;
  border-bottom: 1px solid var(--border-color);
}

.setting-item:last-child {
  border-bottom: none;
}

.setting-info {
  flex: 1;
  margin-right: 18px;
}

.setting-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 6px 0;
}

.setting-description {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  flex-shrink: 0;
}

.prompt-editor-control {
  width: min(520px, 100%);
}

.system-prompt-textarea {
  width: 100%;
  min-height: 140px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  box-sizing: border-box;
}

.prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}

.folder-action-btn {
  --folder-btn-bg: var(--bg-secondary);
  --folder-btn-text: var(--text-primary);
  --folder-btn-border: var(--border-color);
  --folder-btn-hover-bg: var(--hover-bg);
  --folder-btn-hover-border: var(--border-secondary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--folder-btn-border);
  background: var(--folder-btn-bg);
  color: var(--folder-btn-text);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease, opacity 0.2s ease !important;
}

.folder-action-btn:hover {
  background: var(--folder-btn-hover-bg);
  border-color: var(--folder-btn-hover-border);
}

.folder-action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.open-folder-btn {
  --folder-btn-bg: var(--general-settings-open-folder-btn-bg);
  --folder-btn-text: var(--general-settings-open-folder-btn-text);
  --folder-btn-border: var(--general-settings-open-folder-btn-border);
  --folder-btn-hover-bg: var(--general-settings-open-folder-btn-hover-bg);
  --folder-btn-hover-border: var(--general-settings-open-folder-btn-hover-border);
}

.select-folder-btn {
  --folder-btn-bg: var(--general-settings-select-folder-btn-bg);
  --folder-btn-text: var(--general-settings-select-folder-btn-text);
  --folder-btn-border: var(--general-settings-select-folder-btn-border);
  --folder-btn-hover-bg: var(--general-settings-select-folder-btn-hover-bg);
  --folder-btn-hover-border: var(--general-settings-select-folder-btn-hover-border);
}



/* 按钮阴影扩散动画 */
.btn-ripple {
  position: relative;
  overflow: visible;
  /* 确保动画不受全局 transition 干扰 */
  transition: none !important;
  animation: ripple-spread 0.6s cubic-bezier(0.23, 1, 0.32, 1);
}

@keyframes ripple-spread {
  0% {
    box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.4);
  }
  100% {
    box-shadow: 0 0 0 15px rgba(102, 126, 234, 0);
  }
}

.network-group {
  background: var(--network-group-bg);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 0 14px;
  margin: 12px 0;
  box-shadow: 0 2px 12px rgba(0,0,0,.05);
}

.group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  padding: 10px 0 2px 0;
  letter-spacing: 0.03em;
}

.setting-control .toggle-default {
  --toggle-active: #48bb78;
}

.network-group .setting-item:last-child {
  border-bottom: none;
}

.timeout-control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.timeout-input {
  width: 80px;
  padding: 5px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-primary);
  text-align: center;
  outline: none;
  transition: border-color 0.2s;
}

.timeout-input::-webkit-inner-spin-button,
.timeout-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.timeout-input {
  -moz-appearance: textfield;
}

.timeout-input:focus {
  border-color: var(--color-primary, #667eea);
}

.ws-select {
  min-width: 140px;
}

.ws-wide {
  width: 260px;
}

.ws-test-error {
  color: #e53e3e;
}

@media (max-width: 720px) {
  .web-search-group .setting-item {
    flex-wrap: wrap;
    gap: 12px;
  }

  .web-search-group .setting-info {
    flex-basis: 100%;
    margin-right: 0;
  }

  .web-search-group .setting-control {
    max-width: 100%;
  }

  .web-search-group .ws-wide {
    width: min(260px, 100%);
  }
}

.setting-description a {
  color: var(--color-primary, #667eea);
}

.timeout-unit {
  font-size: 12px;
  color: var(--text-secondary);
}

.input-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.form-input[type=number] {
  text-align: center;
  -moz-appearance: textfield;
}

.form-input::-webkit-inner-spin-button,
.form-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}


.input-suffix {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.setting-title-with-help {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
}

.setting-title-with-help .setting-title {
  margin: 0;
}

.help-button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 1px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
}

.help-button:hover {
  color: var(--text-primary);
}

.selected-folder-name {
  color: var(--color-primary);
  font-weight: 500;
}

.selected-folder-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
}

.selected-folder-link:hover {
  text-decoration: underline;
}

.selected-folder-link:disabled {
  opacity: 0.7;
  cursor: default;
  text-decoration: none;
}

.unset-hint {

  color: var(--text-secondary);
  font-style: italic;
}
</style>
