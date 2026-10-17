import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { parseQuestionTable } from '../src/utils/questionTable'
import { highlightText } from '../src/utils/highlightText'

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
