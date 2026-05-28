const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const http = require('http')
const https = require('https')

function resolveEatiPackage() {
  try {
    const entryPath = require.resolve('@esign-cn/veriagent-trust')
    return {
      entryPath,
      module: require(entryPath),
    }
  } catch {
    throw new Error('无法加载 @esign-cn/veriagent-trust，请先执行 npm install 安装 core 依赖')
  }
}

let eatiBindings = null
let sensitiveStateStore = null

function getEatiBindings() {
  if (eatiBindings) {
    return eatiBindings
  }

  const eatiPackage = resolveEatiPackage()
  eatiBindings = {
    ...eatiPackage.module,
    forge: require(require.resolve('node-forge', {
      paths: [path.dirname(eatiPackage.entryPath)],
    })),
  }
  return eatiBindings
}

function getSensitiveStateStore() {
  if (sensitiveStateStore) {
    return sensitiveStateStore
  }

  const eatiPackage = resolveEatiPackage()
  sensitiveStateStore = require(path.join(path.dirname(eatiPackage.entryPath), 'core', 'keytar-compat.js')).loadKeytarCompat()
  return sensitiveStateStore
}

function createSilentEatiLogger() {
  const { Logger, LogLevel } = getEatiBindings()
  return new Logger({
    enabled: false,
    console: false,
    file: false,
    level: LogLevel.NONE,
  })
}

function createDeviceFingerprintInstance() {
  const { DeviceFingerprint } = getEatiBindings()
  return new DeviceFingerprint(createSilentEatiLogger())
}

let LOGGER = console
let COMMAND_CONFIG = getDefaultCommandConfig()
let INSTALL_CONTEXT = resolveInstallContext(COMMAND_CONFIG)
let API_BASE_URL = resolveApiBaseUrl()
let CLIENT_ID = process.env.VERIAGENT_CLIENT_ID || 'plugin_veriagent_prod'
let INSTANCE_NAME = process.env.VERIAGENT_INSTANCE_NAME || os.hostname()
let DEFAULT_SCOPE = process.env.VERIAGENT_SCOPE || 'agent.onboarding agent.certificate.read agent.certificate.write'
let TERMINAL_TYPE = process.env.VERIAGENT_TERMINAL_TYPE || 'OPENCLAW_PLUGIN'
let PLUGIN_HOME = resolveDefaultPluginHome(process.env.VERIAGENT_PLUGIN_HOME, TERMINAL_TYPE)
let STATE_FILE = path.join(PLUGIN_HOME, 'state.json')
let PLUGIN_VERSION = process.env.VERIAGENT_PLUGIN_VERSION || '0.1.0'
let INITIAL_AGENT_NAME = process.env.VERIAGENT_AGENT_NAME || ''
const SENSITIVE_STATE_SERVICE = 'veriagent-plugin-state'
const SENSITIVE_STATE_KEYS = ['sessionToken', 'apiKey']

function configureRuntime(options = {}) {
  LOGGER = options.logger || console
  COMMAND_CONFIG = options.commandConfig || getDefaultCommandConfig()
  INSTALL_CONTEXT = resolveInstallContext(COMMAND_CONFIG, options.installContext || {})
  CLIENT_ID = options.clientId || process.env.VERIAGENT_CLIENT_ID || 'plugin_veriagent_prod'
  INSTANCE_NAME = options.instanceName || process.env.VERIAGENT_INSTANCE_NAME || os.hostname()
  DEFAULT_SCOPE = options.scope || process.env.VERIAGENT_SCOPE || 'agent.onboarding agent.certificate.read agent.certificate.write'
  TERMINAL_TYPE = options.terminalType || process.env.VERIAGENT_TERMINAL_TYPE || 'OPENCLAW_PLUGIN'
  PLUGIN_HOME = resolveDefaultPluginHome(options.pluginHome || process.env.VERIAGENT_PLUGIN_HOME, TERMINAL_TYPE)
  STATE_FILE = path.join(PLUGIN_HOME, 'state.json')
  PLUGIN_VERSION = options.pluginVersion || process.env.VERIAGENT_PLUGIN_VERSION || '0.1.0'
  INITIAL_AGENT_NAME = options.initialAgentName || process.env.VERIAGENT_AGENT_NAME || ''
  API_BASE_URL = resolveApiBaseUrl()
}

function normalizeTerminalType(value) {
  return String(value || '').trim().toUpperCase()
}

function resolveDefaultPluginHome(explicitHome, terminalType) {
  const normalizedExplicitHome = String(explicitHome || '').trim()
  if (normalizedExplicitHome) {
    return normalizedExplicitHome
  }

  if (normalizeTerminalType(terminalType) === 'OPENCLAW_PLUGIN' || normalizeTerminalType(terminalType) === 'OPENCLAW') {
    return path.join(os.homedir(), '.openclaw', 'veriagent')
  }

  return path.join(os.homedir(), '.veriagent-plugin')
}

function logInfo(...args) {
  if (typeof LOGGER?.log === 'function') {
    LOGGER.log(...args)
  }
}

function logWarn(...args) {
  if (typeof LOGGER?.warn === 'function') {
    LOGGER.warn(...args)
    return
  }
  logInfo(...args)
}

function logError(...args) {
  if (typeof LOGGER?.error === 'function') {
    LOGGER.error(...args)
    return
  }
  logWarn(...args)
}

function isKeystoreUnavailableError(error) {
  const message = String(error?.message || '').toLowerCase()
  return (
    message.includes('keystore unavailable') ||
    message.includes('keytar') ||
    message.includes('keychain') ||
    message.includes('credential') ||
    message.includes('.node') ||
    message.includes('dlopen')
  )
}

function getDefaultCommandConfig() {
  return {
    installProfiles: {
      local: {
        portalBaseUrl: 'http://localhost:5174',
        apiBaseUrl: 'http://localhost:6879',
        command: 'openclaw veriagent init',
      },
      beta: {
        portalBaseUrl: 'https://test-app.veriagent.ai',
        apiBaseUrl: 'https://test-veriagent.tsign.cn',
        command: 'openclaw veriagent init',
      },
      prod: {
        portalBaseUrl: 'https://app.veriagent.ai',
        apiBaseUrl: 'https://api.veriagent.ai',
        command: 'openclaw veriagent init',
      },
    },
  }
}

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function loadCommandConfig() {
  const configPath = path.join(__dirname, '..', 'commands.json')
  const loaded = loadJsonFile(configPath)
  if (!loaded || typeof loaded !== 'object') {
    return getDefaultCommandConfig()
  }

  return {
    ...getDefaultCommandConfig(),
    ...loaded,
    installProfiles: {
      ...getDefaultCommandConfig().installProfiles,
      ...(loaded.installProfiles || {}),
    },
  }
}

function loadPackageVersion() {
  const packageJson = loadJsonFile(path.join(__dirname, '..', 'package.json'))
  const version = String(packageJson?.version || '').trim()
  return version
}

function normalizeInstallProfile(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'local' || normalized === 'beta' || normalized === 'prod') {
    return normalized
  }
  return ''
}

function normalizePortalBaseUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '')
  if (!normalized) {
    return ''
  }
  if (!/^https?:\/\//i.test(normalized)) {
    return ''
  }
  return normalized
}

function normalizeApiBaseUrl(value) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return ''
  }

  return normalized
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '')
    .replace(/\/api$/i, '')
    .replace(/\/v1$/i, '')
}

function collectInstallEvidence(packageVersion) {
  return [
    process.env.VERIAGENT_INSTALL_COMMAND,
    process.env.VERIAGENT_INSTALL_PROFILE,
    process.env.VERIAGENT_PORTAL_BASE_URL,
    process.env.VERIAGENT_API_BASE_URL,
    process.env.npm_config_registry,
    process.env.npm_config_package,
    process.env.npm_config_call,
    process.env.npm_config_argv,
    process.env.npm_command,
    process.env.npm_lifecycle_event,
    process.env.npm_lifecycle_script,
    process.env.npm_package_json,
    process.env.npm_package_name,
    process.env.npm_package_version,
    process.env.npm_config_user_agent,
    process.env.npm_execpath,
    process.env._,
    packageVersion,
    process.argv.join(' '),
  ]
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)
}

function detectInstallProfile(evidence) {
  if (evidence.some(item => item.includes('file:') || item.includes('/plugins/veriagent-openclaw') || item.includes('localhost:6879') || item.includes('localhost:5174') || item.includes('127.0.0.1'))) {
    return 'local'
  }

  if (evidence.some(item => item.includes('registry-npm.tsign.cn') || item.includes('test-app.veriagent.ai') || item.includes('test.veriagent.ai'))) {
    return 'beta'
  }

  if (evidence.some(item => item.includes('@beta') || item.includes('-beta') || item.includes('test-app.veriagent.ai') || item.includes('test.veriagent.ai'))) {
    return 'beta'
  }

  return 'prod'
}

function resolveInstallContext(commandConfig, overrides = {}) {
  const explicitProfile = normalizeInstallProfile(overrides.profile || process.env.VERIAGENT_INSTALL_PROFILE)
  const explicitPortalBaseUrl = normalizePortalBaseUrl(overrides.portalBaseUrl || process.env.VERIAGENT_PORTAL_BASE_URL)
  const explicitApiBaseUrl = normalizeApiBaseUrl(overrides.apiBaseUrl || process.env.VERIAGENT_API_BASE_URL)
  const packageVersion = loadPackageVersion()
  const evidence = collectInstallEvidence(packageVersion)
  const profile = explicitProfile || detectInstallProfile(evidence)
  const profileConfig = commandConfig.installProfiles?.[profile] || {}
  const portalBaseUrl = explicitPortalBaseUrl || normalizePortalBaseUrl(profileConfig.portalBaseUrl) || getDefaultCommandConfig().installProfiles[profile].portalBaseUrl
  const apiBaseUrl = explicitApiBaseUrl || normalizeApiBaseUrl(profileConfig.apiBaseUrl) || getDefaultCommandConfig().installProfiles[profile].apiBaseUrl
  const installCommand = String(overrides.installCommand || process.env.VERIAGENT_INSTALL_COMMAND || '').trim() || String(profileConfig.command || '').trim()

  return {
    profile,
    portalBaseUrl,
    apiBaseUrl,
    installCommand,
  }
}

function formatRetryInstallCommand(state = {}) {
  const installCommand = String(state.installCommand || INSTALL_CONTEXT.installCommand || '').trim()
  return `\`${installCommand || 'openclaw veriagent init'}\``
}

async function clearSessionState(state) {
  delete state.sessionId
  delete state.agentId
  delete state.deviceCode
  delete state.userCode
  delete state.verificationUri
  delete state.verificationUriComplete
  delete state.authorizationExpiresIn
  delete state.authorizationInterval
  await clearSensitiveStateValues(state, ['sessionToken'])
}

function extractUrlOrigin(value) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return ''
  }

  try {
    return new URL(normalized).origin.toLowerCase()
  } catch {
    return ''
  }
}

function shouldResetSessionForInstallContext(state) {
  const previousProfile = normalizeInstallProfile(state.installProfile)
  const previousPortalBaseUrl = normalizePortalBaseUrl(state.portalBaseUrl)
  const currentPortalBaseUrl = normalizePortalBaseUrl(INSTALL_CONTEXT.portalBaseUrl)

  if (previousProfile && previousProfile !== INSTALL_CONTEXT.profile) {
    return true
  }

  if (previousPortalBaseUrl && currentPortalBaseUrl && previousPortalBaseUrl !== currentPortalBaseUrl) {
    return true
  }

  const previousVerificationOrigin = extractUrlOrigin(state.verificationUriComplete)
  const currentPortalOrigin = extractUrlOrigin(currentPortalBaseUrl)
  if (previousVerificationOrigin && currentPortalOrigin && previousVerificationOrigin !== currentPortalOrigin) {
    return true
  }

  return false
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
}

async function prepareRuntimeState(options = {}) {
  ensureDir(PLUGIN_HOME)

  if (options.reset) {
    await resetLocalState()
  }

  const state = await loadState()
  if (!state.initId) {
    state.initId = `init_${crypto.randomUUID()}`
  }

  if (shouldResetSessionForInstallContext(state)) {
    await clearSessionState(state)
    logInfo('[veriagent-openclaw] 检测到安装环境已变化，旧的授权会话已失效。')
    logInfo('[veriagent-openclaw] 接下来会重新发起浏览器授权，请按后续提示操作。')
  }

  state.installProfile = INSTALL_CONTEXT.profile
  state.portalBaseUrl = INSTALL_CONTEXT.portalBaseUrl
  state.apiBaseUrl = INSTALL_CONTEXT.apiBaseUrl
  state.installCommand = INSTALL_CONTEXT.installCommand

  saveState(state)
  logInfo('[veriagent-openclaw] 正在检查本地安装环境...')
  logInfo(`[veriagent-openclaw] 插件目录：${PLUGIN_HOME}`)
  logInfo(`[veriagent-openclaw] 安装环境：${state.installProfile}`)
  logInfo(`[veriagent-openclaw] 平台地址：${state.portalBaseUrl}`)
  logInfo(`[veriagent-openclaw] 接口地址：${state.apiBaseUrl}`)
  logInfo(`[veriagent-openclaw] 初始化标识：${state.initId}`)
  return state
}

function loadStateFile() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

async function loadState() {
  const state = loadStateFile()
  for (const key of SENSITIVE_STATE_KEYS) {
    const value = await getSensitiveStateValue(key)
    if (value) {
      state[key] = value
    } else {
      delete state[key]
    }
  }
  return state
}

function saveState(nextState) {
  ensureDir(path.dirname(STATE_FILE))
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(stripSensitiveState(nextState), null, 2)}\n`, { mode: 0o600 })
}

function stripSensitiveState(nextState) {
  const sanitized = { ...(nextState || {}) }
  for (const key of SENSITIVE_STATE_KEYS) {
    delete sanitized[key]
  }
  return sanitized
}

function buildSensitiveStateAccount(key) {
  const pluginHomeHash = crypto.createHash('sha256').update(path.resolve(PLUGIN_HOME), 'utf8').digest('hex')
  return `${pluginHomeHash}:${key}`
}

async function getSensitiveStateValue(key) {
  return getSensitiveStateStore().getPassword(
    SENSITIVE_STATE_SERVICE,
    buildSensitiveStateAccount(key),
  )
}

async function setSensitiveStateValue(state, key, value) {
  const normalizedValue = String(value || '').trim()
  if (!normalizedValue) {
    await clearSensitiveStateValues(state, [key])
    return
  }

  await getSensitiveStateStore().setPassword(
    SENSITIVE_STATE_SERVICE,
    buildSensitiveStateAccount(key),
    normalizedValue,
  )
  state[key] = normalizedValue
}

async function clearSensitiveStateValues(state, keys) {
  const store = getSensitiveStateStore()
  for (const key of keys) {
    delete state[key]
    await store.deletePassword(
      SENSITIVE_STATE_SERVICE,
      buildSensitiveStateAccount(key),
    )
  }
}

async function resetLocalState() {
  try {
    fs.rmSync(STATE_FILE, { force: true })
  } catch {}

  const state = {}
  await clearSensitiveStateValues(state, SENSITIVE_STATE_KEYS)
}

function createPollingReporter() {
  return {
    lastStatusKey: '',
    progressStartedAt: Date.now(),
    transientActive: false,
    lastProgressLine: '',
    lastProgressKey: '',
    currentProgressPercent: 0,
    currentProgressLabel: '',
    progressTimer: null,
  }
}

function stopPollingProgressTimer(reporter) {
  if (!reporter?.progressTimer) {
    return
  }

  clearInterval(reporter.progressTimer)
  reporter.progressTimer = null
}

function formatPollingProgressLine(reporter, percent, label) {
  const progress = normalizeProgressPercent(percent)
  const message = String(label || '处理中').trim() || '处理中'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - reporter.progressStartedAt) / 1000))
  return `${message}（已经等待 ${elapsedSeconds} 秒），当前进度 ${progress}%`
}

function measureDisplayWidth(text) {
  let width = 0
  for (const char of String(text || '')) {
    width += /[^\u0000-\u00ff]/.test(char) ? 2 : 1
  }
  return width
}

function truncateDisplayText(text, maxWidth) {
  const normalized = String(text || '')
  if (maxWidth <= 0 || measureDisplayWidth(normalized) <= maxWidth) {
    return normalized
  }

  const ellipsis = '...'
  const ellipsisWidth = measureDisplayWidth(ellipsis)
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth)
  let width = 0
  let result = ''

  for (const char of normalized) {
    const charWidth = /[^\u0000-\u00ff]/.test(char) ? 2 : 1
    if (width + charWidth > targetWidth) {
      break
    }
    result += char
    width += charWidth
  }

  return `${result}${ellipsis}`
}

function renderPollingProgress(reporter) {
  const progressLine = formatPollingProgressLine(
    reporter,
    reporter.currentProgressPercent,
    reporter.currentProgressLabel,
  )

  if (process.stdout.isTTY) {
    const prefix = '[veriagent-openclaw] progress '
    const terminalWidth = Number(process.stdout.columns || 120)
    const maxLineWidth = Math.max(20, terminalWidth - 1)
    const safeLine = truncateDisplayText(
      `${prefix}${progressLine}`,
      maxLineWidth,
    )
    process.stdout.write(`\r\x1b[2K${safeLine}`)
    reporter.transientActive = true
    return
  }

  if (reporter.lastProgressLine !== progressLine) {
    logInfo(`[veriagent-openclaw] progress ${progressLine}`)
    reporter.lastProgressLine = progressLine
  }
}

function ensurePollingProgressTimer(reporter) {
  if (!process.stdout.isTTY || reporter.progressTimer) {
    return
  }

  reporter.progressTimer = setInterval(() => {
    if (!reporter.currentProgressLabel) {
      return
    }
    renderPollingProgress(reporter)
  }, 1000)

  if (typeof reporter.progressTimer.unref === 'function') {
    reporter.progressTimer.unref()
  }
}

function clearPollingReporter(reporter) {
  stopPollingProgressTimer(reporter)
  if (!reporter?.transientActive) {
    return
  }

  if (process.stdout.isTTY) {
    process.stdout.write('\r\x1b[2K')
  }
  reporter.transientActive = false
}

function printPollingLines(reporter, lines) {
  clearPollingReporter(reporter)
  for (const line of lines) {
    logInfo(line)
  }
  if (reporter) {
    reporter.progressStartedAt = Date.now()
    reporter.lastProgressLine = ''
    reporter.lastProgressKey = ''
    reporter.currentProgressPercent = 0
    reporter.currentProgressLabel = ''
  }
}

function showPollingProgress(reporter, percent, label) {
  const progress = normalizeProgressPercent(percent)
  const message = String(label || '处理中').trim() || '处理中'
  const progressKey = `${progress}|${message}`
  if (reporter.lastProgressKey === progressKey) {
    return
  }

  reporter.lastProgressKey = progressKey
  reporter.currentProgressPercent = progress
  reporter.currentProgressLabel = message
  reporter.lastProgressLine = ''
  renderPollingProgress(reporter)
  ensurePollingProgressTimer(reporter)
}

function normalizeProgressPercent(percent) {
  const numeric = Number(percent)
  if (!Number.isFinite(numeric)) {
    return 0
  }

  return Math.max(0, Math.min(100, Math.round(numeric)))
}

function resolveAuthorizationProgress(pollStatus) {
  if (pollStatus === 'approved') {
    return {
      percent: 12,
      label: '浏览器授权已完成，正在建立终端会话',
    }
  }

  return {
    percent: 8,
    label: '等待你在浏览器完成授权',
  }
}

function resolveOnboardingProgress(status, options = {}) {
  const invalidApiKeyState = !!options.invalidApiKeyState

  if (invalidApiKeyState) {
    return {
      percent: 18,
      label: '检测到本地 API Key 无效，等待你在浏览器重新创建智能体',
    }
  }

  if (status.pageStatus === 'CREATE_AGENT_REQUIRED') {
    return {
      percent: 20,
      label: '等待你在浏览器创建 API Key 和空智能体',
    }
  }

  if (status.pageStatus === 'PROFILE_REQUIRED' && status.nextAction === 'WAIT_BROWSER_CONFIRM') {
    return {
      percent: 35,
      label: '等待你在浏览器完成信息采集',
    }
  }

  if (status.pageStatus === 'PROFILE_REQUIRED' && status.nextAction === 'GENERATE_CSR') {
    return {
      percent: 55,
      label: '正在生成并提交本地 CSR 材料',
    }
  }

  if (status.pageStatus === 'WILL_AND_APPLY_REQUIRED') {
    return {
      percent: 78,
      label: '等待你在浏览器完成意愿认证和证书申请',
    }
  }

  if (status.pageStatus === 'CERT_DOWNLOAD_REQUIRED' && status.nextAction === 'DOWNLOAD_CERTIFICATE') {
    return {
      percent: 92,
      label: '证书已签发，正在保存到插件目录',
    }
  }

  if (status.pageStatus === 'ACTIVE') {
    return {
      percent: 100,
      label: '智能体已激活',
    }
  }

  return {
    percent: 60,
    label: '正在继续推进智能体申请流程',
  }
}

function buildOnboardingStatusKey(status) {
  return [
    status.pageStatus || '',
    status.nextAction || '',
    status.statusMessage || '',
    status.actionUrl || '',
    status.agentId || '',
    status.apiKeyStatus || '',
  ].join('|')
}

function resolveDisplayStatusMessage(status) {
  if (status.pageStatus === 'CREATE_AGENT_REQUIRED' && status.apiKeyStatus === 'INVALID') {
    return '检测到本地 API Key 不符合平台要求，请在浏览器重新创建智能体。'
  }

  if (status.pageStatus === 'CREATE_AGENT_REQUIRED') {
    return '当前还没有可用智能体，请先在浏览器页面创建一个智能体。'
  }

  if (status.pageStatus === 'PROFILE_REQUIRED' && status.nextAction === 'WAIT_BROWSER_CONFIRM') {
    return '正在等待你在浏览器补充信息，请继续完成页面上的填写。'
  }

  if (status.pageStatus === 'PROFILE_REQUIRED' && status.nextAction === 'GENERATE_CSR') {
    return '页面信息已经完整，终端正在生成本地 CSR 申请材料。'
  }

  if (status.pageStatus === 'WILL_AND_APPLY_REQUIRED') {
    return '请继续在浏览器完成意愿认证，并提交证书申请。'
  }

  if (status.pageStatus === 'CERT_DOWNLOAD_REQUIRED' && status.nextAction === 'DOWNLOAD_CERTIFICATE') {
    return '证书已经签发，终端正在保存证书到插件目录。'
  }

  if (status.pageStatus === 'ACTIVE') {
    return '智能体已经激活，可以开始使用签名和验签能力。'
  }

  return String(status?.statusMessage || '').trim() || '正在继续推进智能体申请流程。'
}

function readLocalAgentInfo(agentId) {
  const agentDir = getAgentDir(agentId)
  const materialsPath = path.join(agentDir, 'materials.json')
  const certificatePath = path.join(agentDir, 'certificate.json')
  const materials = fs.existsSync(materialsPath)
    ? JSON.parse(fs.readFileSync(materialsPath, 'utf8'))
    : null
  const certificate = fs.existsSync(certificatePath)
    ? JSON.parse(fs.readFileSync(certificatePath, 'utf8'))
    : null

  return {
    agentId,
    agentDir,
    materials,
    certificate,
  }
}

function readCertificatePem(agentInfo) {
  const filePath = agentInfo.certificate?.certificateFile
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`未找到智能体 ${agentInfo.agentId} 的证书文件`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

function readPrivateKeyPem(agentInfo) {
  const filePath = agentInfo.materials?.privateKeyPath
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`未找到智能体 ${agentInfo.agentId} 的私钥文件`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

function isKeystoreBackedMode(mode) {
  return typeof mode === 'string' && mode.startsWith('keystore')
}

async function migrateLegacyFileMode(agentInfo) {
  const filePath = agentInfo.materials?.privateKeyPath
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`智能体 ${agentInfo.agentId} 缺少旧版私钥文件，无法迁移到 keystore-v2`)
  }

  const logger = createSilentEatiLogger()
  const { KeyManager, forge } = getEatiBindings()
  const keyManager = new KeyManager({
    keystoreService: 'veriagent-plugin',
    keyStorePath: agentInfo.agentDir,
  }, logger)
  keyManager.privateKey = forge.pki.privateKeyFromPem(fs.readFileSync(filePath, 'utf8'))
  const keyMetadata = await keyManager.savePrivateKey(agentInfo.agentId)

  const nextMaterials = {
    ...(agentInfo.materials || {}),
    storageMode: keyMetadata.storageMode,
    kmkAlias: keyMetadata.kmkAlias,
    kmkVersion: keyMetadata.kmkVersion,
    protectionLevel: keyMetadata.protectionLevel,
    activeKeyAlias: keyMetadata.activeKeyAlias,
    kekFile: keyMetadata.kekFile,
    keyFile: keyMetadata.keyFile,
    privateKeyPath: '',
    updatedAt: new Date().toISOString(),
  }
  const metadataPath = path.join(agentInfo.agentDir, 'materials.json')
  fs.writeFileSync(metadataPath, `${JSON.stringify(nextMaterials, null, 2)}\n`, { mode: 0o600 })
  fs.unlinkSync(filePath)
  agentInfo.materials = nextMaterials
  return nextMaterials
}

function createFileModeSignature(payload, privateKeyPem, certPem) {
  const logger = createSilentEatiLogger()
  const { KeyManager, CertificateManager, SignatureService, forge } = getEatiBindings()
  const keyManager = new KeyManager({ keystoreService: 'veriagent-plugin' }, logger)
  keyManager.privateKey = forge.pki.privateKeyFromPem(privateKeyPem)
  keyManager.derivePublicKey()
  const certManager = new CertificateManager({}, logger)
  certManager.importCertificate(certPem)
  const signatureService = new SignatureService(keyManager, certManager, logger)
  return signatureService.sign(payload, false).signature
}

function verifyFileModeSignature(payload, signature, certPem) {
  const logger = createSilentEatiLogger()
  const { KeyManager, CertificateManager, SignatureService } = getEatiBindings()
  const keyManager = new KeyManager({ keystoreService: 'veriagent-plugin' }, logger)
  const certManager = new CertificateManager({}, logger)
  certManager.importCertificate(certPem)
  const signatureService = new SignatureService(keyManager, certManager, logger)
  return signatureService.verify(payload, signature)
}

function generateDeviceAeid() {
  return createDeviceFingerprintInstance().generateAEID()
}

function computeAeidHash(aeid) {
  return createDeviceFingerprintInstance().computeAEIDHash(aeid)
}

function buildInstallPathHash() {
  const normalizedPath = path.resolve(PLUGIN_HOME).trim().toLowerCase()
  return crypto.createHash('sha256').update(normalizedPath, 'utf8').digest('hex')
}

function buildBaseDeviceFingerprint() {
  const deviceAeid = generateDeviceAeid()
  const aeidHash = computeAeidHash(deviceAeid)
  const installPathHash = buildInstallPathHash()
  const canonical = `v1|aeid=${aeidHash}|path=${installPathHash}`
  return {
    baseDeviceFingerprintHash: crypto.createHash('sha256').update(canonical, 'utf8').digest('hex'),
    baseDeviceFingerprintVersion: 'v1',
  }
}

function normalizeSubjectPart(value, maxLength, fallback) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return fallback
  }

  return normalized.length <= maxLength
    ? normalized
    : normalized.slice(0, maxLength)
}

function buildGuardianSubjectId(value) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return 'guardian-unknown'
  }

  const safe = normalized.replace(/[^a-zA-Z0-9_-]/g, '')
  if (safe && safe.length <= 24) {
    return safe
  }

  return `g_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 20)}`
}

function buildCsrSubject(subject) {
  return {
    agentId: normalizeSubjectPart(subject.agentId, 24, 'agent'),
    guardianId: buildGuardianSubjectId(subject.guardianId),
    aeidString: String(subject.aeidString || '').trim().toLowerCase(),
    frameworkType: normalizeSubjectPart(subject.frameworkType, 16, 'custom'),
    purpose: normalizeSubjectPart(subject.purpose, 16, 'assistant'),
  }
}

function createLocalCsr(subjectInput, publicKeyPem, privateKeyPem) {
  const { CSRGenerator, forge } = getEatiBindings()
  const deviceAeid = generateDeviceAeid()
  const subject = buildCsrSubject(subjectInput)
  const csrGenerator = new CSRGenerator(createSilentEatiLogger())
  const generated = csrGenerator.createCSR(
    subject,
    forge.pki.publicKeyFromPem(publicKeyPem),
    forge.pki.privateKeyFromPem(privateKeyPem),
    deviceAeid
  )
  const parsed = csrGenerator.parseCSR(generated.csr)
  const aeidHash = parsed.subject.aeidString

  return {
    csr: generated.csr,
    aeid: generated.aeid,
    aeidHash,
  }
}

function parseLocalCsr(csrPem) {
  const { CSRGenerator } = getEatiBindings()
  return new CSRGenerator(createSilentEatiLogger()).parseCSR(csrPem)
}

async function getStatusSnapshot() {
  ensureDir(PLUGIN_HOME)
  const state = await loadState()
  const output = {
    pluginHome: PLUGIN_HOME,
    initId: state.initId || '',
    installProfile: state.installProfile || INSTALL_CONTEXT.profile,
    portalBaseUrl: state.portalBaseUrl || INSTALL_CONTEXT.portalBaseUrl,
    apiBaseUrl: state.apiBaseUrl || INSTALL_CONTEXT.apiBaseUrl,
    sessionId: state.sessionId || '',
    sessionTokenPresent: Boolean(state.sessionToken),
    agentId: state.agentId || '',
    apiKeyPresent: Boolean(state.apiKey),
    certificateFile: state.certificateFile || '',
    remoteStatus: null,
  }

  if (state.sessionId && state.sessionToken) {
    try {
      output.remoteStatus = await fetchStatus(state)
    } catch (error) {
      output.remoteStatus = {
        error: error.message,
      }
    }
  }

  return output
}

function listLocalAgents() {
  ensureDir(PLUGIN_HOME)
  const agentsRoot = path.join(PLUGIN_HOME, 'agents')
  if (!fs.existsSync(agentsRoot)) {
    return []
  }

  return fs.readdirSync(agentsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => readLocalAgentInfo(entry.name))
    .map(item => ({
      agentId: item.agentId,
      agentDir: item.agentDir,
      storageMode: item.materials?.storageMode || '',
      frameworkType: item.materials?.frameworkType || '',
      certSn: item.certificate?.certSn || '',
      certificateFile: item.certificate?.certificateFile || '',
      downloadedAt: item.certificate?.downloadedAt || '',
    }))
}

function normalizePayloadInput(input) {
  if (!input || !input.kind || !Buffer.isBuffer(input.content)) {
    throw new Error('无效的签名输入，必须提供 { kind, source, content<Buffer> }')
  }

  return {
    kind: input.kind,
    source: input.source || 'inline',
    content: input.content,
  }
}

async function signContent(agentId, input) {
  ensureDir(PLUGIN_HOME)
  if (!agentId) {
    throw new Error('缺少 agentId')
  }

  const normalizedInput = normalizePayloadInput(input)
  const agentInfo = readLocalAgentInfo(agentId)
  if (!agentInfo.materials || !agentInfo.certificate) {
    throw new Error(`找不到智能体 ${agentId} 的本地证书或密钥，请先执行 \`openclaw veriagent status\``)
  }

  let signature = ''
  let mode = agentInfo.materials.storageMode || 'unknown'

  if (!isKeystoreBackedMode(mode)) {
    const migrated = await migrateLegacyFileMode(agentInfo)
    mode = migrated.storageMode || mode
  }

  const { EsignAgentTrust } = getEatiBindings()
  const sdk = new EsignAgentTrust({
    keystoreService: 'veriagent-plugin',
    certStorePath: path.join(agentInfo.agentDir, 'certificates'),
    keyStorePath: agentInfo.agentDir,
  })
  const loaded = await sdk.load(agentId)
  if (!loaded) {
    throw new Error(`无法加载智能体 ${agentId} 的本地密钥材料，请确认本地文件是否完整`)
  }
  signature = sdk.sign(normalizedInput.content).signature

  return {
    agentId,
    inputType: normalizedInput.kind,
    source: normalizedInput.source,
    algorithm: 'RSA-SHA256',
    storageMode: mode,
    signature,
    signedAt: new Date().toISOString(),
  }
}

async function verifyContent(agentId, input, signature) {
  ensureDir(PLUGIN_HOME)
  if (!agentId) {
    throw new Error('缺少 agentId')
  }

  if (!signature) {
    throw new Error('缺少 signature')
  }

  const normalizedInput = normalizePayloadInput(input)
  const agentInfo = readLocalAgentInfo(agentId)
  if (!agentInfo.certificate) {
    throw new Error(`智能体 ${agentId} 没有本地证书，请先完成安装流程`)
  }

  let mode = agentInfo.materials?.storageMode || 'unknown'
  const certPem = readCertificatePem(agentInfo)
  const valid = verifyFileModeSignature(normalizedInput.content, signature, certPem)

  return {
    agentId,
    inputType: normalizedInput.kind,
    source: normalizedInput.source,
    storageMode: mode,
    valid,
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function shouldResumeIncompleteAgent(status) {
  const agentId = String(status?.agentId || '').trim()
  if (!agentId) {
    return false
  }

  return [
    'PROFILE_REQUIRED',
    'WILL_AND_APPLY_REQUIRED',
    'CERT_DOWNLOAD_REQUIRED',
  ].includes(String(status?.pageStatus || '').trim())
}

function resolvePortalBaseUrl() {
  return INSTALL_CONTEXT.portalBaseUrl
}

function resolveApiBaseUrl() {
  return normalizeApiBaseUrl(INSTALL_CONTEXT.apiBaseUrl) || 'http://localhost:6879'
}

async function requestJson(method, pathname, options = {}) {
  const url = pathname.startsWith('http') ? pathname : `${API_BASE_URL}${pathname}`
  const headers = {
    'content-type': 'application/json; charset=UTF-8',
    ...(options.headers || {}),
  }
  const bodyText = options.body ? JSON.stringify(options.body) : ''
  if (bodyText) {
    headers['content-length'] = Buffer.byteLength(bodyText)
  }

  let response
  try {
    response = await sendJsonRequest(url, {
      method,
      headers,
      body: bodyText || undefined,
    })
  } catch (error) {
    const message = error?.message || 'unknown network error'
    throw new Error(`request failed: ${method} ${url} (${message})`)
  }

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    const message = payload?.message || `${method} ${url} failed with ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload?.data ?? null
}

function sendJsonRequest(urlString, options) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
    }, response => {
      const chunks = []
      response.on('data', chunk => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8')
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          async json() {
            if (!responseText) {
              return null
            }
            return JSON.parse(responseText)
          },
        })
      })
    })

    request.on('error', reject)

    if (options.body) {
      request.write(options.body)
    }

    request.end()
  })
}

function buildBrowserRecoveryUrl(state, options = {}) {
  if (state.verificationUriComplete) {
    const url = new URL(state.verificationUriComplete)
    if (options.forceCreate) {
      url.searchParams.set('force_create', '1')
    }
    return url.toString()
  }

  if (state.userCode) {
    const url = new URL('/skill/agent', `${resolvePortalBaseUrl()}/`)
    url.searchParams.set('user_code', state.userCode)
    if (options.forceCreate) {
      url.searchParams.set('force_create', '1')
    }
    return url.toString()
  }

  return ''
}

function buildAgentDetailUrl(agentId) {
  const normalized = String(agentId || '').trim()
  if (!normalized) {
    return ''
  }

  const url = new URL(`/skill/agent/detail/${normalized}`, `${resolvePortalBaseUrl()}/`)
  return url.toString()
}

function parseAgentIdFromCertificatePem(certPem) {
  try {
    const { CertificateManager } = getEatiBindings()
    const certManager = new CertificateManager({}, createSilentEatiLogger())
    certManager.importCertificate(certPem)
    return certManager.getAgentId()
  } catch {
    return ''
  }
}

function resolveAgentIdFromLocalCertificate(state) {
  const directCertificatePath = String(state.certificateFile || '').trim()
  if (directCertificatePath && fs.existsSync(directCertificatePath)) {
    const parsedAgentId = parseAgentIdFromCertificatePem(fs.readFileSync(directCertificatePath, 'utf8'))
    if (parsedAgentId) {
      return parsedAgentId
    }
  }

  const agentsRoot = path.join(PLUGIN_HOME, 'agents')
  if (!fs.existsSync(agentsRoot)) {
    return ''
  }

  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    const agentInfo = readLocalAgentInfo(entry.name)
    const certificatePath = agentInfo.certificate?.certificateFile
    if (!certificatePath || !fs.existsSync(certificatePath)) {
      continue
    }

    const parsedAgentId = parseAgentIdFromCertificatePem(fs.readFileSync(certificatePath, 'utf8'))
    if (parsedAgentId) {
      return parsedAgentId
    }
  }

  return ''
}

async function ensureAuthorized(state) {
  const reporter = createPollingReporter()
  if (state.sessionId && state.sessionToken) {
    try {
      const status = await fetchStatus(state)
      const expectedPortalOrigin = extractUrlOrigin(INSTALL_CONTEXT.portalBaseUrl)
      const remoteActionOrigin = extractUrlOrigin(status?.actionUrl)
      if (expectedPortalOrigin && remoteActionOrigin && expectedPortalOrigin !== remoteActionOrigin) {
        throw new Error('当前缓存会话对应的平台地址已变化，旧会话不能继续使用')
      }

      if (shouldResumeIncompleteAgent(status)) {
        const resumedAgentId = String(status?.agentId || state.agentId || '').trim()
        if (resumedAgentId) {
          if (state.agentId && state.agentId !== resumedAgentId) {
            await clearSensitiveStateValues(state, ['apiKey'])
          }
          state.agentId = resumedAgentId
          saveState(state)
          logInfo(`[veriagent-openclaw] 检测到未完成的智能体流程，继续处理：${resumedAgentId}`)
          if (status?.actionUrl) {
            logInfo(`[veriagent-openclaw] 继续处理地址：${status.actionUrl}`)
          } else {
            logInfo(`[veriagent-openclaw] 智能体详情：${buildAgentDetailUrl(resumedAgentId)}`)
          }
        }
        logInfo(`[veriagent-openclaw] 已复用未完成安装会话：${state.sessionId}`)
        if (status?.apiKeyPlainText && !state.apiKey && resumedAgentId === status?.agentId) {
          await setSensitiveStateValue(state, 'apiKey', status.apiKeyPlainText)
          saveState(state)
        }
        return
      }

      logInfo('[veriagent-openclaw] 当前缓存会话对应的智能体已完成或不属于可继续状态，开始新的安装流程。')
      await clearSessionState(state)
      saveState(state)
    } catch (error) {
      logInfo(`[veriagent-openclaw] 检测到旧会话已不可用，正在重新发起浏览器授权：${error.message}`)
      await clearSessionState(state)
      saveState(state)
    }
  }

  const authorization = await requestJson('POST', '/v1/plugin/device-authorizations', {
    body: {
      clientId: CLIENT_ID,
      initId: state.initId,
      agentName: INITIAL_AGENT_NAME,
      instanceName: INSTANCE_NAME,
      scope: DEFAULT_SCOPE,
      installProfile: INSTALL_CONTEXT.profile,
      installCommand: INSTALL_CONTEXT.installCommand,
      portalBaseUrl: INSTALL_CONTEXT.portalBaseUrl,
      ...buildBaseDeviceFingerprint(),
      forceCreate: false,
    },
  })

  state.deviceCode = authorization.deviceCode
  state.userCode = authorization.userCode
  state.verificationUri = authorization.verificationUri
  state.verificationUriComplete = authorization.verificationUriComplete
  state.authorizationExpiresIn = authorization.expiresIn
  state.authorizationInterval = authorization.interval
  saveState(state)

  logInfo('\n[veriagent-openclaw] 需要你在浏览器完成授权，请按下面步骤操作：')
  logInfo(`  1. 打开这个地址：${authorization.verificationUriComplete}`)
  logInfo(`  2. 查看用户码：${authorization.userCode}`)
  logInfo('  3. 在页面完成授权')
  logInfo('  4. 完成后回到终端，程序会自动继续')
  logInfo(`[veriagent-openclaw] 本次用户码有效期：${authorization.expiresIn} 秒`)

  while (true) {
    const poll = await requestJson('POST', '/v1/plugin/device-authorizations/token', {
      body: {
        clientId: CLIENT_ID,
        deviceCode: state.deviceCode,
      },
    })

    if (poll?.status === 'authorization_pending') {
      const authorizationProgress = resolveAuthorizationProgress(poll?.status)
      showPollingProgress(reporter, authorizationProgress.percent, authorizationProgress.label)
      await sleep((authorization.interval || 5) * 1000)
      continue
    }

    if (poll?.status === 'access_denied') {
      clearPollingReporter(reporter)
      throw new Error(`浏览器中未完成授权，或用户主动拒绝了授权：${poll.reason || 'access_denied'}`)
    }

    if (poll?.status === 'expired_token') {
      clearPollingReporter(reporter)
      throw new Error(`本次授权已过期，请重新执行 ${formatRetryInstallCommand(state)}`)
    }

    if (poll?.status !== 'approved') {
      clearPollingReporter(reporter)
      throw new Error(`收到无法识别的授权状态：${poll?.status || 'unknown'}`)
    }

    state.sessionId = poll.sessionId
    await setSensitiveStateValue(state, 'sessionToken', poll.sessionToken)
    if (poll.apiKey) {
      await setSensitiveStateValue(state, 'apiKey', poll.apiKey)
    }
    state.agentId = poll.agentId || state.agentId
    saveState(state)

    const authorizationProgress = resolveAuthorizationProgress('approved')
    clearPollingReporter(reporter)
    logInfo('[veriagent-openclaw] 浏览器授权已完成，正在建立终端会话...')
    logInfo(`[veriagent-openclaw] 会话创建成功：${state.sessionId}`)
    return
  }
}

async function runOnboardingLoop(state) {
  let createAgentHintShown = false
  let invalidApiKeyHintShown = false
  let willActionUrlShown = ''
  const reporter = createPollingReporter()

  while (true) {
    const status = await fetchStatus(state)
    if (status?.apiKeyPlainText && !state.apiKey) {
      await setSensitiveStateValue(state, 'apiKey', status.apiKeyPlainText)
      saveState(state)
    }
    if (status?.agentId) {
      state.agentId = status.agentId
      saveState(state)
    }

    const invalidApiKeyState = status.pageStatus === 'CREATE_AGENT_REQUIRED'
      && status.apiKeyStatus === 'INVALID'

    if (!invalidApiKeyState) {
      invalidApiKeyHintShown = false
    }
    if (status.pageStatus !== 'CREATE_AGENT_REQUIRED') {
      createAgentHintShown = false
    }
    if (status.pageStatus !== 'WILL_AND_APPLY_REQUIRED') {
      willActionUrlShown = ''
    }

    const statusKey = buildOnboardingStatusKey(status)
    const statusChanged = statusKey !== reporter.lastStatusKey
    const progress = resolveOnboardingProgress(status, { invalidApiKeyState })
    if (statusChanged) {
      reporter.lastStatusKey = statusKey
      const displayStatusMessage = resolveDisplayStatusMessage(status)
      printPollingLines(reporter, [
        `\n[veriagent-openclaw] 当前进度：${progress.percent}% | 当前阶段：${displayStatusMessage}`,
        `[veriagent-openclaw] 系统状态：pageStatus=${status.pageStatus}，nextAction=${status.nextAction}`,
      ])
    }

    if (invalidApiKeyState) {
      await clearSensitiveStateValues(state, ['apiKey'])
      delete state.agentId
      saveState(state)

      if (!invalidApiKeyHintShown) {
        const recoveryUrl = status.actionUrl || buildBrowserRecoveryUrl(state, { forceCreate: true })
        logInfo('[veriagent-openclaw] 当前本地 API Key 不符合平台要求，需要重新创建合规智能体。')
        if (recoveryUrl) {
          logInfo('[veriagent-openclaw] 请重新打开下面的地址继续处理：')
          logInfo(`  ${recoveryUrl}`)
          logInfo('[veriagent-openclaw] 完成后回到终端，程序会自动继续。')
        }
        invalidApiKeyHintShown = true
      } else {
        showPollingProgress(reporter, progress.percent, progress.label)
      }

      await sleep(status.pollIntervalMs || 3000)
      continue
    }

    if (status.pageStatus === 'CREATE_AGENT_REQUIRED') {
      if (!createAgentHintShown) {
        const createUrl = status.actionUrl || buildBrowserRecoveryUrl(state)
        logInfo('[veriagent-openclaw] 需要你在浏览器继续操作：创建 API Key，并创建一个空智能体。')
        if (createUrl) {
          logInfo('[veriagent-openclaw] 打开下面的地址继续：')
          logInfo(`  ${createUrl}`)
          logInfo('[veriagent-openclaw] 完成后回到终端，程序会自动继续。')
        }
        createAgentHintShown = true
      } else if (!statusChanged) {
        showPollingProgress(reporter, progress.percent, progress.label)
      }
      await sleep(status.pollIntervalMs || 3000)
      continue
    }

    if (status.pageStatus === 'PROFILE_REQUIRED' && status.nextAction === 'WAIT_BROWSER_CONFIRM') {
      if (!statusChanged) {
        showPollingProgress(reporter, progress.percent, progress.label)
      }
      await sleep(status.pollIntervalMs || 3000)
      continue
    }

    if (status.pageStatus === 'PROFILE_REQUIRED' && status.nextAction === 'GENERATE_CSR') {
      clearPollingReporter(reporter)
      await submitLocalMaterials(state, status)
      await sleep(status.pollIntervalMs || 3000)
      continue
    }

    if (status.pageStatus === 'WILL_AND_APPLY_REQUIRED') {
      if (status.actionUrl && status.actionUrl !== willActionUrlShown) {
        clearPollingReporter(reporter)
        logInfo('[veriagent-openclaw] 需要你在浏览器继续操作：完成意愿认证，并提交证书申请。')
        logInfo('[veriagent-openclaw] 打开下面的地址继续：')
        logInfo(`  ${status.actionUrl}`)
        logInfo('[veriagent-openclaw] 完成后回到终端，程序会自动继续。')
        willActionUrlShown = status.actionUrl
      } else if (!statusChanged) {
        showPollingProgress(reporter, progress.percent, progress.label)
      }
      await sleep(status.pollIntervalMs || 3000)
      continue
    }

    if (status.pageStatus === 'CERT_DOWNLOAD_REQUIRED' && status.nextAction === 'DOWNLOAD_CERTIFICATE') {
      clearPollingReporter(reporter)
      await saveCertificateToPluginDir(state, status)
      await sleep(status.pollIntervalMs || 3000)
      continue
    }

    if (status.pageStatus === 'ACTIVE') {
      const resolvedAgentId = status.agentId || state.agentId || resolveAgentIdFromLocalCertificate(state)
      if (resolvedAgentId && resolvedAgentId !== state.agentId) {
        state.agentId = resolvedAgentId
        saveState(state)
      }

      clearPollingReporter(reporter)
      logInfo('[veriagent-openclaw] 智能体已激活，可以开始使用。')
      if (state.certificateFile) {
        logInfo(`[veriagent-openclaw] 证书保存路径：${state.certificateFile}`)
      }
      if (resolvedAgentId) {
        logInfo(`[veriagent-openclaw] 智能体详情：${buildAgentDetailUrl(resolvedAgentId)}`)
      }
      return
    }

    if (!statusChanged) {
      showPollingProgress(reporter, progress.percent, progress.label)
    }
    await sleep(status.pollIntervalMs || 3000)
  }
}

async function fetchStatus(state) {
  const search = new URLSearchParams({
    sessionId: state.sessionId,
  })

  if (state.agentId) {
    search.set('agentId', state.agentId)
  }
  if (state.apiKey) {
    search.set('apiKeyPreview', state.apiKey)
  }

  return requestJson('GET', `/v1/agent-plugin/status?${search.toString()}`, {
    headers: {
      'x-plugin-session-token': state.sessionToken,
    },
  })
}

function getAgentDir(agentId) {
  const agentDir = path.join(PLUGIN_HOME, 'agents', agentId)
  ensureDir(agentDir)
  return agentDir
}

async function submitLocalMaterials(state, status) {
  const agentId = status.agentId || state.agentId
  if (!agentId) {
    throw new Error('远端状态中缺少 agentId，暂时无法继续申请流程')
  }
  if (!state.apiKey) {
    throw new Error('缺少 apiKey，暂时无法提交本地材料')
  }

  const materials = await ensureLocalMaterials(agentId, status)
  const result = await requestJson('POST', '/v1/agent-certificates/applications', {
    headers: {
      'x-api-key': state.apiKey,
    },
    body: {
      agentId,
      publicKeyPem: materials.publicKeyPem,
      csrPem: materials.csrPem,
      aeidHash: materials.aeidHash,
      terminalType: TERMINAL_TYPE,
      pluginVersion: PLUGIN_VERSION,
    },
  })

  state.agentId = agentId
  state.lastSubmittedAgentId = agentId
  saveState(state)
  logInfo(`[veriagent-openclaw] 本地 CSR 材料已提交，当前状态：${result.status}`)
}

async function ensureLocalMaterials(agentId, status) {
  const agentDir = getAgentDir(agentId)
  const publicKeyPath = path.join(agentDir, 'public-key.pem')
  const csrPath = path.join(agentDir, 'request.csr')
  const metadataPath = path.join(agentDir, 'materials.json')

  if (fs.existsSync(publicKeyPath) && fs.existsSync(csrPath) && fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    return {
      publicKeyPem: fs.readFileSync(publicKeyPath, 'utf8'),
      csrPem: fs.readFileSync(csrPath, 'utf8'),
      aeidHash: metadata.aeidHash,
      storageMode: metadata.storageMode,
      kmkAlias: metadata.kmkAlias || '',
    }
  }

  const { KeyManager } = getEatiBindings()
  const keyManager = new KeyManager({
    keystoreService: 'veriagent-plugin',
    keyStorePath: agentDir,
  })
  const keyPair = keyManager.generateKeyPair()
  const keyMetadata = await keyManager.savePrivateKey(agentId)

  const csrSubject = status.csrSubject || {}
  const subject = {
    agentId,
    guardianId: csrSubject.guardianId || 'unknown-guardian',
    aeidString: '',
    frameworkType: csrSubject.frameworkType || status.agentProfile?.frameworkType || 'custom',
    purpose: csrSubject.purpose || 'assistant',
  }

  const generated = createLocalCsr(subject, keyPair.publicKey, keyPair.privateKey)
  const parsed = parseLocalCsr(generated.csr)
  const aeidHash = parsed.subject.aeidString

  fs.writeFileSync(publicKeyPath, keyPair.publicKey, { mode: 0o600 })
  fs.writeFileSync(csrPath, generated.csr, { mode: 0o600 })
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    agentId,
    agentName: status.agentName || status.agentProfile?.agentName || '',
    aeidHash,
    storageMode: keyMetadata.storageMode,
    kmkAlias: keyMetadata.kmkAlias,
    kmkVersion: keyMetadata.kmkVersion,
    protectionLevel: keyMetadata.protectionLevel,
    activeKeyAlias: keyMetadata.activeKeyAlias,
    kekFile: keyMetadata.kekFile,
    keyFile: keyMetadata.keyFile,
    privateKeyPath: '',
    frameworkType: subject.frameworkType,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })

  logInfo(`[veriagent-openclaw] 已为智能体 ${agentId} 生成本地密钥材料`)
  return {
    publicKeyPem: keyPair.publicKey,
    csrPem: generated.csr,
    aeidHash,
    storageMode: keyMetadata.storageMode,
    kmkAlias: keyMetadata.kmkAlias,
  }
}

async function saveCertificateToPluginDir(state, status) {
  if (!state.sessionId || !state.sessionToken || !state.agentId) {
    throw new Error(`缺少会话或智能体上下文，暂时无法保存证书，请重新执行 ${formatRetryInstallCommand(state)}`)
  }

  const result = status?.certificate
  if (!result?.certPem) {
    throw new Error('远端状态中缺少待保存证书内容，请稍后重试')
  }

  const agentDir = getAgentDir(state.agentId)
  const certDir = path.join(agentDir, 'certificates')
  ensureDir(certDir)
  const resolvedFileName = String(result.fileName || '').trim() || 'certificate.pem'
  const finalPath = path.join(certDir, resolvedFileName)

  fs.writeFileSync(finalPath, result.certPem, { mode: 0o600 })

  const metadataPath = path.join(agentDir, 'certificate.json')
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    agentId: state.agentId,
    certSn: result.certSn,
    certExpireAt: result.certExpireAt,
    checksumSha256: result.checksumSha256,
    importedByEati: false,
    certificateFile: finalPath,
    downloadedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })

  await requestJson('POST', '/v1/agent-certificates/confirm-stored', {
    headers: {
      'x-plugin-session-token': state.sessionToken,
    },
    body: {
      sessionId: state.sessionId,
      agentId: state.agentId,
    },
  })

  state.certificateFile = finalPath
  state.certificateChecksum = result.checksumSha256
  saveState(state)
  logInfo(`[veriagent-openclaw] 证书已保存到插件目录：${finalPath}`)
}

function buildPayloadInput(params = {}) {
  const text = typeof params.text === 'string' ? params.text : ''
  const filePath = typeof params.filePath === 'string' ? params.filePath : ''

  if (text && filePath) {
    throw new Error('`text` 和 `filePath` 只能二选一')
  }

  if (!text && !filePath) {
    throw new Error('必须提供 `text` 或 `filePath`')
  }

  if (filePath) {
    const resolvedFilePath = path.resolve(filePath)
    return {
      kind: 'file',
      source: resolvedFilePath,
      content: fs.readFileSync(resolvedFilePath),
    }
  }

  return {
    kind: 'text',
    source: 'inline',
    content: Buffer.from(text, 'utf8'),
  }
}

async function runInstallFlow(options = {}) {
  const state = await prepareRuntimeState(options)
  await ensureAuthorized(state)
  await runOnboardingLoop(state)
  return getStatusSnapshot()
}

function createRuntime(options = {}) {
  configureRuntime(options)

  return {
    buildPayloadInput,
    getRuntimeConfig() {
      return {
        pluginHome: PLUGIN_HOME,
        stateFile: STATE_FILE,
        installContext: { ...INSTALL_CONTEXT },
        apiBaseUrl: API_BASE_URL,
        clientId: CLIENT_ID,
        instanceName: INSTANCE_NAME,
        terminalType: TERMINAL_TYPE,
        pluginVersion: PLUGIN_VERSION,
      }
    },
    async install(runOptions = {}) {
      return runInstallFlow(runOptions)
    },
    async status() {
      return getStatusSnapshot()
    },
    listAgents() {
      return listLocalAgents()
    },
    async sign(agentId, payload) {
      return signContent(agentId, payload)
    },
    async verify(agentId, payload, signature) {
      return verifyContent(agentId, payload, signature)
    },
    async reset() {
      await resetLocalState()
      return {
        pluginHome: PLUGIN_HOME,
        stateFile: STATE_FILE,
      }
    },
  }
}

module.exports = {
  createRuntime,
  buildPayloadInput,
  configureRuntime,
}
