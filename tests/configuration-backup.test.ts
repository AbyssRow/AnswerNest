import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIGURATION_FORMAT, createConfigurationBackup, exportConfiguration, importConfiguration, parseConfigurationBackup } from '../src/services/configurationBackup'

const example = () => ({
  format: CONFIGURATION_FORMAT, version: 1, appVersion: '1.4.0', exportedAt: '2026-10-25T00:00:00Z',
  settings: {
    theme: 'dark', language: 'zh-CN', autoSave: false, closeToTray: true,
    modelResponseTimeout: 60, modelRetryCount: 2,
    network: { serverPort: 3021, enableLanAccess: false, bindAddress: '192.0.2.1' },
    questionSaveDir: 'Windows 上的题库文件夹', questionSaveFolderId: 123,
    windowSize: { width: 4000, height: 2000 }, windowPosition: { x: -4000, y: 0 },
    webSearch: {
      enabled: true, provider: 'exa', apiKey: 'fixture-exa-key', baseUrl: 'https://exa.example', proxyUrl: 'socks5://localhost:7890', exaType: 'lite',
      providerSettings: {
        firecrawl: { apiKey: 'fixture-firecrawl-key', baseUrl: 'https://firecrawl.example', proxyUrl: '' },
        deepseek: { apiKey: 'fixture-deepseek-key', baseUrl: '', proxyUrl: 'http://localhost:7891' }
      }
    }
  },
  models: {
    selectedTextModel: 'model_1', selectedTextModels: ['model_1'],
    selectedSummaryModel: 'model_1', selectedSummaryModels: ['model_1'], selectedVisionModel: null,
    platforms: [{
      id: 'custom_fixture', name: 'fixture', displayName: '迁移测试平台', baseUrl: 'https://ai.example/v1',
      apiKey: 'fixture-model-key', enabled: true, proxyUrl: 'http://localhost:7890', customHeaders: { 'X-Fixture': 'header-value' },
      models: [{ id: 'model_1', platformId: 'custom_fixture', name: 'fixture', displayName: '迁移测试模型', category: 'text', enabled: true, supportsVision: true, apiProtocol: 'custom', jsCode: 'async function processModel() { return "fixture" }', maxTokens: 2048, temperature: 0, topP: 1, enableThinking: false, extraBody: { custom: { enabled: true } }, omitParameters: ['seed'] }]
    }],
    globalSettings: { timeout: 45000, retryCount: 2, enableLogging: false }
  }
})

test('configuration backup preserves keys, model selections, parameters and independent search connections', () => {
  const source = example()
  const json = createConfigurationBackup(source.settings as any, source.models as any, '1.4.0')
  const restored = parseConfigurationBackup('\uFEFF' + json)
  assert.equal(restored.appVersion, '1.4.0')
  assert.deepEqual(restored.models, source.models)
  assert.equal(restored.settings.webSearch!.apiKey, 'fixture-exa-key')
  assert.equal(restored.settings.webSearch!.providerSettings!.firecrawl!.apiKey, 'fixture-firecrawl-key')
  assert.equal(restored.settings.webSearch!.providerSettings!.deepseek!.proxyUrl, 'http://localhost:7891')
  assert.equal(restored.settings.webSearch!.exaType, 'lite')
  assert.equal(restored.models.platforms[0].models[0].temperature, 0)
  assert.equal(restored.settings.network!.bindAddress, '127.0.0.1')
  for (const key of ['questionSaveDir', 'questionSaveFolderId', 'windowSize', 'windowPosition']) assert.equal(key in restored.settings, false)
  assert.equal(source.settings.network.bindAddress, '192.0.2.1')
})

test('legacy models without name can be exported without changing model IDs, selections or source data', () => {
  const source = example()
  const legacy = source.models.platforms[0].models[0] as any
  delete legacy.name
  legacy.displayName = '旧版模型别名'
  legacy.modelId = 'fixture-runtime-model'
  const before = JSON.stringify(source)
  const restored = parseConfigurationBackup(createConfigurationBackup(source.settings as any, source.models as any, '1.4.1'))
  const model = restored.models.platforms[0].models[0]
  assert.equal(model.name, 'fixture-runtime-model')
  assert.equal(model.displayName, '旧版模型别名')
  assert.equal(model.modelId, 'fixture-runtime-model')
  assert.equal(model.id, 'model_1')
  assert.equal(restored.models.platforms[0].apiKey, 'fixture-model-key')
  assert.deepEqual(restored.models.selectedTextModels, ['model_1'])
  assert.deepEqual(restored.models.selectedSummaryModels, ['model_1'])
  assert.equal(JSON.stringify(source), before)
  for (const name of [null, '', '  ']) {
    legacy.name = name
    delete legacy.modelId
    assert.equal(parseConfigurationBackup(JSON.stringify(source)).models.platforms[0].models[0].name, '旧版模型别名')
  }
})

test('configuration backup rejects malformed files and unsupported versions before import', () => {
  for (const text of ['', '{', 'null', '[]', '{"platforms":[]}']) assert.throws(() => parseConfigurationBackup(text), /配置/)
  assert.throws(() => parseConfigurationBackup(JSON.stringify({ ...example(), version: 2 })), /版本/)
  const mutations = [
    (b: any) => { b.settings.network.serverPort = '3000' },
    (b: any) => { b.settings.autoSave = 0 },
    (b: any) => { b.settings.webSearch = [] },
    (b: any) => { b.settings.webSearch.provider = 'unknown' },
    (b: any) => { b.settings.webSearch.providerSettings.deepseek.apiKey = {} },
    (b: any) => { b.models.platforms[0].models = {} },
    (b: any) => { b.models.platforms[0].apiKey = {} },
    (b: any) => { b.models.platforms[0].models[0].name = {} },
    (b: any) => { b.models.platforms[0].models[0].id = '' },
    (b: any) => { b.models.platforms.push(b.models.platforms[0]) },
    (b: any) => { b.models.platforms[0].models.push(b.models.platforms[0].models[0]) },
    (b: any) => { b.models.platforms[0].models[0].extraBody = [] },
    (b: any) => { b.models.selectedTextModels = [123] },
    (b: any) => { b.models.globalSettings = null }
  ]
  for (const mutate of mutations) {
    const backup = example()
    mutate(backup)
    assert.throws(() => parseConfigurationBackup(JSON.stringify(backup)), /格式不正确/)
  }
  assert.throws(() => parseConfigurationBackup(JSON.stringify(example()).replace('"version":1', '"__proto__":{"polluted":true},"version":1')), /无法读取/)
  assert.equal(({} as any).polluted, undefined)
})

test('configuration import persists both files, preserves target device values, and restores after write failure', async () => {
  const descriptors = Object.fromEntries(['localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const memory = new Map<string, string>()
  const files = new Map<string, string>()
  let failSettingsWrite = false
  let rejectModelKey = ''
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: { invoke: async (command: string, args: any) => {
    if (command.startsWith('read_')) return ''
    if (command === 'write_config' && failSettingsWrite) { failSettingsWrite = false; throw new Error('disk full') }
    if (command === 'write_model_config' && rejectModelKey && JSON.parse(args.content).platforms[0]?.apiKey === rejectModelKey) throw new Error('model config is read only')
    files.set(command, args.content)
  } } } })
  const { environmentDetector } = await import('../src/services/environmentDetector')
  environmentDetector.resetCache()
  const [{ settingsManager }, { modelConfigManager }, { nextTick }] = await Promise.all([import('../src/services/settings'), import('../src/services/modelConfig'), import('vue')])
  await Promise.all([settingsManager.ready(), modelConfigManager.ready()])
  const previousSettings = settingsManager.export()
  const previousModels = modelConfigManager.export()
  try {
    settingsManager.set('autoSave', false)
    settingsManager.set('questionSaveDir', 'Mac 本机目录')
    settingsManager.set('questionSaveFolderId', 456)
    settingsManager.set('windowPosition', { x: 100, y: 150 })
    await importConfiguration(parseConfigurationBackup(JSON.stringify(example())))
    assert.equal(settingsManager.get('questionSaveDir'), 'Mac 本机目录')
    assert.equal(settingsManager.get('questionSaveFolderId'), 456)
    assert.deepEqual(settingsManager.get('windowPosition'), { x: 100, y: 150 })
    assert.equal(settingsManager.get('theme'), 'dark')
    assert.equal(JSON.parse(files.get('write_config')!).webSearch.apiKey, 'fixture-exa-key')
    assert.equal(JSON.parse(files.get('write_model_config')!).platforms[0].apiKey, 'fixture-model-key')
    assert.deepEqual(modelConfigManager.getSettings().selectedTextModels, ['model_1'])
    assert.deepEqual(modelConfigManager.getSettings().selectedSummaryModels, ['model_1'])
    const exported = parseConfigurationBackup(await exportConfiguration('1.4.0'))
    assert.deepEqual(exported.models, modelConfigManager.getSettings())
    const beforeSettings = settingsManager.export()
    const beforeModels = modelConfigManager.export()
    const invalid = example()
    invalid.models.platforms[0].apiKey = {} as any
    await assert.rejects(importConfiguration(invalid as any), /格式不正确/)
    assert.equal(settingsManager.export(), beforeSettings)
    assert.equal(modelConfigManager.export(), beforeModels)
    const replacement = example()
    replacement.settings.theme = 'light'
    replacement.models.platforms[0].apiKey = 'replacement-key'
    failSettingsWrite = true
    await assert.rejects(importConfiguration(parseConfigurationBackup(JSON.stringify(replacement))), /已恢复原配置/)
    assert.equal(settingsManager.export(), beforeSettings)
    assert.equal(modelConfigManager.export(), beforeModels)
    assert.equal(files.get('write_config'), beforeSettings)
    assert.deepEqual(JSON.parse(files.get('write_model_config')!), JSON.parse(beforeModels))
    rejectModelKey = 'replacement-key'
    await assert.rejects(importConfiguration(parseConfigurationBackup(JSON.stringify(replacement))), /已恢复原配置/)
    assert.equal(settingsManager.export(), beforeSettings)
    assert.equal(modelConfigManager.export(), beforeModels)
    assert.equal(files.get('write_config'), beforeSettings)
    assert.deepEqual(JSON.parse(files.get('write_model_config')!), JSON.parse(beforeModels))
  } finally {
    settingsManager.import(previousSettings)
    modelConfigManager.import(previousModels)
    await nextTick()
    await Promise.allSettled([settingsManager.save(), modelConfigManager.save()])
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    environmentDetector.resetCache()
  }
})
