#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')

const COMMAND_CONFIG = loadCommandConfig()
const INSTALL_CONTEXT = resolveInstallContext(COMMAND_CONFIG)
const PACKAGE_VERSION = loadPackageVersion() || '0.1.0'
const ARGS = process.argv.slice(2).filter(arg => arg !== '--')
const COMMAND = ARGS[0] || 'run'
const RESET = ARGS.includes('--reset')
const PLUGIN_HOME = process.env.VERIAGENT_PLUGIN_HOME || path.join(os.homedir(), '.openclaw', 'veriagent')

main().catch(error => {
  const message = String(error?.message || 'unknown error')
  if (message.startsWith('request failed: ')) {
    console.error(`\n[veriagent-openclaw] 请求失败：${message.slice('request failed: '.length)}`)
    console.error('[veriagent-openclaw] 请检查网络、代理配置或平台地址后重试。')
    console.error('[veriagent-openclaw] 可重新执行刚才的命令，或先运行 `openclaw veriagent status` 排查当前状态。')
  } else {
    console.error(`\n[veriagent-openclaw] 当前操作未完成：${message}`)
    console.error('[veriagent-openclaw] 你可以先执行 `openclaw veriagent status` 查看当前状态。')
    console.error('[veriagent-openclaw] 如果你是第一次使用，建议执行 `openclaw veriagent init` 重新开始。')
  }
  process.exitCode = 1
})

async function main() {
  if (COMMAND === 'help' || COMMAND === '--help' || COMMAND === '-h') {
    printHelp()
    return
  }

  const { createRuntime } = loadVeriagentCore()
  const runtime = createRuntime({
    commandConfig: COMMAND_CONFIG,
    installContext: INSTALL_CONTEXT,
    pluginHome: PLUGIN_HOME,
    clientId: process.env.VERIAGENT_CLIENT_ID || 'plugin_veriagent_prod',
    instanceName: process.env.VERIAGENT_INSTANCE_NAME || os.hostname(),
    scope: process.env.VERIAGENT_SCOPE || 'agent.onboarding agent.certificate.read agent.certificate.write',
    terminalType: process.env.VERIAGENT_TERMINAL_TYPE || 'OPENCLAW_PLUGIN',
    pluginVersion: process.env.VERIAGENT_PLUGIN_VERSION || PACKAGE_VERSION,
    initialAgentName: process.env.VERIAGENT_AGENT_NAME || '',
  })

  if (COMMAND === 'reset') {
    const result = await runtime.reset()
    console.log(`[veriagent-openclaw] 已清除本地缓存：${result.stateFile}`)
    console.log('[veriagent-openclaw] 如果需要重新安装，请执行 `openclaw veriagent init`。')
    return
  }

  if (COMMAND === 'status') {
    const result = await runtime.status()
    if (result.remoteStatus?.error) {
      console.log('[veriagent-openclaw] 远端状态暂时无法获取，但本地状态仍可用于排查。')
    }
    console.log('[veriagent-openclaw] 当前状态如下，重点关注 sessionId、agentId、certificateFile 和 remoteStatus。')
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (COMMAND === 'list-agents') {
    const list = runtime.listAgents()
    if (list.length === 0) {
      console.log('[veriagent-openclaw] 当前没有找到本地智能体材料。')
      console.log('[veriagent-openclaw] 如果你还没完成安装，请执行 `openclaw veriagent init`。')
      return
    }

    console.log(`[veriagent-openclaw] 已找到 ${list.length} 个本地智能体，以下是详细信息：`)
    console.log(JSON.stringify(list, null, 2))
    return
  }

  if (COMMAND === 'sign') {
    const [agentId] = getPositionalArgs()
    if (!agentId) {
      throw new Error("缺少 <agentId>。示例：openclaw veriagent sign <agentId> --text 'hello'")
    }
    const result = await runtime.sign(agentId, buildPayloadInput(runtime))
    console.log(JSON.stringify(result, null, 2))
    console.log('[veriagent-openclaw] 签名已完成，可使用返回结果中的 signature 进行验签。')
    return
  }

  if (COMMAND === 'verify') {
    const [agentId] = getPositionalArgs()
    const signature = getArgValue(['--signature'])
    if (!agentId) {
      throw new Error("缺少 <agentId>。示例：openclaw veriagent verify <agentId> --text 'hello' --signature '<base64>'")
    }
    if (!signature) {
      throw new Error("缺少 `--signature`。示例：--signature '<base64>'")
    }
    const result = await runtime.verify(agentId, buildPayloadInput(runtime), signature)
    console.log(JSON.stringify(result, null, 2))
    console.log('[veriagent-openclaw] 验签已完成，`valid=true` 表示签名有效。')
    return
  }

  if (['run', 'install', 'init', 'onboard'].includes(COMMAND)) {
    await runtime.install({ reset: RESET })
    return
  }

  throw new Error(`未知命令：${COMMAND}\n[veriagent-openclaw] 可执行 \`veriagent-openclaw help\` 查看支持的命令`)
}

function loadVeriagentCore() {
  const candidates = [
    '@esign-cn/veriagent-core',
    '../../../packages/veriagent-core',
    '../core',
  ]

  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {}
  }

  throw new Error('无法加载 @esign-cn/veriagent-core，请确认本地 core 目录或依赖已准备好')
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
  return String(packageJson?.version || '').trim()
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
  if (!normalized || !/^https?:\/\//i.test(normalized)) {
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

function resolveInstallContext(commandConfig) {
  const explicitProfile = normalizeInstallProfile(process.env.VERIAGENT_INSTALL_PROFILE)
  const explicitPortalBaseUrl = normalizePortalBaseUrl(process.env.VERIAGENT_PORTAL_BASE_URL)
  const explicitApiBaseUrl = normalizeApiBaseUrl(process.env.VERIAGENT_API_BASE_URL)
  const packageVersion = loadPackageVersion()
  const evidence = collectInstallEvidence(packageVersion)
  const profile = explicitProfile || detectInstallProfile(evidence)
  const profileConfig = commandConfig.installProfiles?.[profile] || {}

  return {
    profile,
    portalBaseUrl: explicitPortalBaseUrl || normalizePortalBaseUrl(profileConfig.portalBaseUrl) || getDefaultCommandConfig().installProfiles[profile].portalBaseUrl,
    apiBaseUrl: explicitApiBaseUrl || normalizeApiBaseUrl(profileConfig.apiBaseUrl) || getDefaultCommandConfig().installProfiles[profile].apiBaseUrl,
    installCommand: String(process.env.VERIAGENT_INSTALL_COMMAND || '').trim() || String(profileConfig.command || '').trim(),
  }
}

function getArgValue(flagNames) {
  for (let index = 0; index < ARGS.length; index += 1) {
    const current = ARGS[index]
    if (!flagNames.includes(current)) {
      continue
    }

    const next = ARGS[index + 1]
    if (!next || next.startsWith('--')) {
      throw new Error(`参数 \`${current}\` 缺少取值\n[veriagent-openclaw] 可执行 \`veriagent-openclaw help\` 查看该命令的正确用法`)
    }
    return next
  }

  return ''
}

function getPositionalArgs() {
  const positional = []
  for (let index = 1; index < ARGS.length; index += 1) {
    const current = ARGS[index]
    if (current.startsWith('--')) {
      index += 1
      continue
    }
    positional.push(current)
  }
  return positional
}

function buildPayloadInput(runtime) {
  const text = getArgValue(['--text'])
  const filePath = getArgValue(['--file'])

  if (text && filePath) {
    throw new Error('`--text` 和 `--file` 只能二选一，请保留其中一个')
  }
  if (!text && !filePath) {
    throw new Error('未提供待处理内容，请使用 `--text` 或 `--file`')
  }

  return runtime.buildPayloadInput({ text, filePath })
}

function printHelp() {
  console.log(`
VeriAgent OpenClaw CLI

首次使用建议：
  1. 运行 \`openclaw veriagent init\`
  2. 按提示在浏览器完成授权、创建智能体和证书申请
  3. 完成后运行 \`openclaw veriagent status\` 查看结果

用法：
  openclaw veriagent <command> [options]

常用命令：
  install | run | init | onboard   首次安装，或继续未完成的安装流程
  status                           查看本地状态和远端会话状态
  list-agents                      查看本地已保存的智能体材料
  reset                            清除本地缓存，重新开始安装
  sign <agentId> --text <text>     对一段文本进行签名
  sign <agentId> --file <path>     对文件内容进行签名
  verify <agentId> --text <text> --signature <base64>
  verify <agentId> --file <path> --signature <base64>

示例：
  openclaw veriagent init
  openclaw veriagent status
  openclaw veriagent sign <agentId> --text 'hello'
  openclaw veriagent verify <agentId> --text 'hello' --signature '<base64>'

环境变量：
  VERIAGENT_API_BASE_URL
  VERIAGENT_PORTAL_BASE_URL
  VERIAGENT_INSTALL_PROFILE
  VERIAGENT_INSTALL_COMMAND
  VERIAGENT_PLUGIN_HOME
  VERIAGENT_CLIENT_ID
  VERIAGENT_INSTANCE_NAME
`.trim())
}
