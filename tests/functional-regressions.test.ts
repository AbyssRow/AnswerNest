import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { parseQuestionTable } from '../src/utils/questionTable'
import { highlightText } from '../src/utils/highlightText'
import { loadQuestionImages, waitForAttachment } from '../src/utils/questionAttachments'

test('image questions require every image and preserve attachment order', async () => {
  const inline = 'data:image/png;base64,INLINE'
  const fetched: string[] = []
  const images = await loadQuestionImages([inline, 'https://example.com/b.png', inline, 'https://example.com/c.png'], async url => {
    fetched.push(url)
    return url.endsWith('b.png') ? 'data:image/png;base64,B' : 'data:image/png;base64,C'
  })
  assert.deepEqual(images, [inline, 'data:image/png;base64,B', 'data:image/png;base64,C'])
  assert.deepEqual(fetched, ['https://example.com/b.png', 'https://example.com/c.png'])
  await assert.rejects(loadQuestionImages([inline, 'https://example.com/missing.png'], async () => '', { retryDelayMs: 0 }), /未能全部加载（1\/2，第 2 张）/)
  await assert.rejects(loadQuestionImages(['https://example.com/missing.png', inline], async () => { throw new Error('network error') }, { retryDelayMs: 0 }), /未能全部加载（1\/2，第 1 张）/)
})

test('image downloads retry failures without downloading successful images again', async () => {
  const urls = ['https://example.com/ready.png', 'https://example.com/flaky.png']
  const calls = new Map<string, number>()
  const result = await loadQuestionImages(urls, async url => {
    const attempt = (calls.get(url) ?? 0) + 1
    calls.set(url, attempt)
    if (url.endsWith('flaky.png')) {
      if (attempt === 1) return ''
      if (attempt === 2) throw new Error('temporary network error')
    }
    return `data:image/png;base64,${url.endsWith('ready.png') ? 'READY' : 'RECOVERED'}`
  }, { retryDelayMs: 0 })
  assert.deepEqual(result, ['data:image/png;base64,READY', 'data:image/png;base64,RECOVERED'])
  assert.deepEqual([...calls.values()], [1, 3])
  let attempts = 0
  await assert.rejects(loadQuestionImages([urls[1]], async () => { attempts++; return '' }, { retryDelayMs: 0 }), /重试后仍未能全部加载/)
  assert.equal(attempts, 3)
})

test('cancelled image downloads stop waiting and do not start retries', async () => {
  const controller = new AbortController()
  let calls = 0
  const pending = loadQuestionImages(['https://example.com/slow.png'], async () => {
    calls++
    return new Promise<string>(() => {})
  }, { signal: controller.signal, retryDelayMs: 0 })
  controller.abort(new DOMException('图片准备超时', 'TimeoutError'))
  await assert.rejects(pending, /图片准备超时/)
  assert.equal(calls, 1)
  await assert.rejects(loadQuestionImages(['https://example.com/unused.png'], async () => {
    calls++
    return 'unexpected'
  }, { signal: controller.signal }), /图片准备超时/)
  assert.equal(calls, 1)
})

test('image preparation timeout also stops waiting for decoding and resizing', async () => {
  const controller = new AbortController()
  let finishDecode!: (value: string) => void
  const decode = new Promise<string>(resolve => { finishDecode = resolve })
  const pending = waitForAttachment(decode, controller.signal)
  controller.abort(new DOMException('题目图片准备超时', 'TimeoutError'))
  await assert.rejects(pending, /题目图片准备超时/)
  finishDecode('late image')
  assert.equal(await waitForAttachment(Promise.resolve('ready')), 'ready')
})

test('CSV import preserves commas, escaped quotes, multiline cells, zero and leading zeros', () => {
  const csv = '\ufeffID,题目,选项,答案,类型,创建时间\r\n1,"计算 1,2 的和\n并解释 ""原因""","A. 0\nB. 3","0",填空题,2026-10-17\r\n2,编号,,00123,填空题,\r\n'
  assert.deepEqual(parseQuestionTable(csv), [
    { question: '计算 1,2 的和\n并解释 "原因"', options: 'A. 0\nB. 3', answer: '0', question_type: '填空题' },
    { question: '编号', options: null, answer: '00123', question_type: '填空题' },
  ])
})

test('XLSX import converts numeric and boolean answers to text without losing zero', () => {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['题目', '选项', '答案', '类型'],
    ['零', '', 0, '填空题'],
    ['判断', '', false, '判断题'],
    ['编号', '', '00123', '填空题'],
    ['', '', '忽略空题', ''],
  ]), '题目')
  const rows = parseQuestionTable(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }))
  assert.deepEqual(rows.map(row => row.answer), ['0', 'FALSE', '00123'])
})

test('question display preserves HTML examples, inequalities and literal search characters', () => {
  assert.equal(highlightText('示例 <div> & x<2'), '示例 &lt;div&gt; &amp; x&lt;2')
  assert.equal(highlightText('C++ 与 C+', ['C++']), '<mark class="search-highlight">C++</mark> 与 C+')
  assert.equal(highlightText('<b>示例</b>', ['<b>']), '<mark class="search-highlight">&lt;b&gt;</mark>示例&lt;/b&gt;')
  assert.equal(highlightText('A & B', ['&']), 'A <mark class="search-highlight">&amp;</mark> B')
})

test('model reset, disabling/deleting selections, and legacy config imports remain consistent', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const memory = new Map<string, string>()
  memory.set('model_settings', JSON.stringify({ platforms: [], globalSettings: {} }))
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  } })
  try {
    const { modelConfigManager: manager } = await import('../src/services/modelConfig')
    const { nextTick } = await import('vue')
    const settings = manager.getSettings()
    for (let attempt = 0; attempt < 2; attempt++) {
      manager.addPlatform({ name: 'test', displayName: 'test', baseUrl: '', apiKey: 'test-key', enabled: true, models: [] })
      manager.updateGlobalSettings({ timeout: 1 })
      manager.reset()
      assert.deepEqual(settings.platforms, [])
      assert.equal(settings.globalSettings.timeout, 30000)
    }
    const platformId = manager.addPlatform({ name: 'test', displayName: 'test', baseUrl: '', apiKey: '', enabled: true, models: [] })
    const modelId = manager.addModelToPlatform(platformId, { name: 'test', displayName: 'test', maxTokens: 100, temperature: 0, topP: 1, enabled: true, category: 'text', supportsVision: true })
    manager.setSelectedTextModel(modelId)
    manager.setSelectedSummaryModel(modelId)
    manager.updateModel(modelId, { enabled: false })
    assert.deepEqual(manager.getSelectedTextModels(), [])
    assert.deepEqual(manager.getSelectedSummaryModels(), [])
    manager.updateModel(modelId, { enabled: true })
    manager.setSelectedSummaryModel(modelId)
    manager.removeModel(modelId)
    assert.equal(settings.selectedSummaryModel, null)
    assert.deepEqual(settings.selectedSummaryModels, [])
    manager.import(JSON.stringify({ platforms: [], globalSettings: { timeout: 5000 }, selectedTextModels: null }))
    assert.equal(settings.globalSettings.retryCount, 3)
    assert.equal(settings.globalSettings.timeout, 5000)
    assert.deepEqual(settings.selectedTextModels, [])
    const before = manager.export()
    assert.throws(() => manager.import('null'), /配置导入失败/)
    assert.equal(manager.export(), before)
    manager.reset()
    await nextTick()
    await (manager as any).pendingFileSave.catch(() => {})
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('manual settings save waits for disk, preserves write order, and reports write failures', async () => {
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const writes: { content: string; resolve: () => void; reject: (error: Error) => void }[] = []
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: (command: string, args: any) => command === 'read_config' ? Promise.resolve('') : new Promise<void>((resolve, reject) => writes.push({ content: args.content, resolve, reject })) },
  } })
  const { environmentDetector } = await import('../src/services/environmentDetector')
  environmentDetector.resetCache()
  try {
    const { settingsManager: manager } = await import('../src/services/settings')
    const { nextTick } = await import('vue')
    manager.set('autoSave', false)
    await nextTick()
    manager.set('questionSaveFolderId', 1)
    let completed = false
    const first = manager.save().then(() => { completed = true })
    const tick = () => new Promise(resolve => setTimeout(resolve, 0))
    await tick()
    assert.equal(writes.length, 1)
    assert.equal(completed, false)
    manager.set('questionSaveFolderId', 2)
    const second = manager.save()
    await tick()
    assert.equal(writes.length, 1)
    writes[0].resolve()
    await first
    await tick()
    assert.equal(writes.length, 2)
    assert.equal(JSON.parse(writes[1].content).questionSaveFolderId, 2)
    writes[1].resolve()
    await second
    const failed = manager.save()
    const assertion = assert.rejects(failed, /disk full/)
    await tick()
    writes[2].reject(new Error('disk full'))
    await assertion
    const retry = manager.save()
    await tick()
    writes[3].resolve()
    await retry
  } finally {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    environmentDetector.resetCache()
  }
})
