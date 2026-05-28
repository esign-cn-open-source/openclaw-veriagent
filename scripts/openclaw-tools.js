const path = require('path')
const os = require('os')

const packageJson = require('../package.json')
const pluginManifest = require('../openclaw.plugin.json')
const PLUGIN_HOME = process.env.VERIAGENT_PLUGIN_HOME || path.join(os.homedir(), '.openclaw', 'veriagent')

let installAttemptPromise = null

function tryLoadDefinePluginEntry() {
  try {
    const sdk = require('openclaw/plugin-sdk/plugin-entry')
    if (typeof sdk?.definePluginEntry === 'function') {
      return sdk.definePluginEntry
    }
  } catch {}

  return definition => definition
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

  throw new Error('无法加载 @esign-cn/veriagent-core，请先安装插件依赖或确认依赖包已可用')
}

function createToolResult(title, payload, extraMessage) {
  const parts = [title]
  if (payload) {
    parts.push(JSON.stringify(payload, null, 2))
  }
  if (extraMessage) {
    parts.push(extraMessage)
  }

  return {
    content: [
      {
        type: 'text',
        text: parts.join('\n\n'),
      },
    ],
  }
}

function buildNoArgSchema() {
  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }
}

function buildSignToolSchema() {
  return {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: '本地已安装智能体的 agentId。',
      },
      text: {
        type: 'string',
        description: '待签名文本，和 filePath 二选一。',
      },
      filePath: {
        type: 'string',
        description: '待签名文件路径，和 text 二选一。',
      },
    },
    required: ['agentId'],
    additionalProperties: false,
  }
}

function buildVerifyToolSchema() {
  return {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: '本地已安装智能体的 agentId。',
      },
      text: {
        type: 'string',
        description: '待验签文本，和 filePath 二选一。',
      },
      filePath: {
        type: 'string',
        description: '待验签文件路径，和 text 二选一。',
      },
      signature: {
        type: 'string',
        description: 'Base64 签名值。',
      },
    },
    required: ['agentId', 'signature'],
    additionalProperties: false,
  }
}

function createRuntimeForTool() {
  const { createRuntime } = loadVeriagentCore()
  return createRuntime({
    pluginHome: PLUGIN_HOME,
    clientId: process.env.VERIAGENT_CLIENT_ID || 'plugin_veriagent_prod',
    instanceName: process.env.VERIAGENT_INSTANCE_NAME || os.hostname(),
    scope: process.env.VERIAGENT_SCOPE || 'agent.onboarding agent.certificate.read agent.certificate.write',
    terminalType: process.env.VERIAGENT_TERMINAL_TYPE || 'OPENCLAW_PLUGIN',
    pluginVersion: process.env.VERIAGENT_PLUGIN_VERSION || packageJson.version,
    initialAgentName: process.env.VERIAGENT_AGENT_NAME || '',
    installContext: {
      profile: process.env.VERIAGENT_INSTALL_PROFILE,
      portalBaseUrl: process.env.VERIAGENT_PORTAL_BASE_URL,
      apiBaseUrl: process.env.VERIAGENT_API_BASE_URL,
      installCommand: process.env.VERIAGENT_INSTALL_COMMAND || 'openclaw veriagent init',
    },
  })
}

function hasInstalledCertificate(status) {
  return Boolean(status?.certificateFile)
}

async function startInstallFlow(reason) {
  if (installAttemptPromise) {
    return installAttemptPromise
  }

  const runtime = createRuntimeForTool()
  installAttemptPromise = (async () => {
    const status = await runtime.status()
    if (hasInstalledCertificate(status)) {
      console.log('[veriagent-openclaw] 已检测到本地证书材料，跳过自动安装。')
      return status
    }

    if (reason !== 'silent') {
      console.log('[veriagent-openclaw] 收到安装指令，开始执行 VeriAgent 安装流程。')
    }

    return runtime.install()
  })()
    .catch(error => {
      console.error(`[veriagent-openclaw] 安装流程未完成：${error.message}`)
      throw error
    })
    .finally(() => {
      installAttemptPromise = null
    })

  return installAttemptPromise
}

function buildPayloadInput(runtime, params) {
  const text = typeof params?.text === 'string' ? params.text : ''
  const filePath = typeof params?.filePath === 'string' ? params.filePath : ''

  return runtime.buildPayloadInput({
    text,
    filePath,
  })
}

async function ensureCertificateReady() {
  const runtime = createRuntimeForTool()
  const status = await runtime.status()
  if (hasInstalledCertificate(status)) {
    return runtime
  }

  if (installAttemptPromise) {
    throw new Error('VeriAgent 安装流程仍在进行中，请先按控制台提示完成浏览器授权。')
  }

  throw new Error('VeriAgent 尚未完成安装，请先等待自动安装流程输出验证地址，或直接调用 `veriagent_install`。')
}

async function executeInstall() {
  const result = await startInstallFlow('tool_call')
  return createToolResult('安装流程完成。', result, '[veriagent-openclaw] 如已看到 certificateFile，表示本地证书材料已就绪。')
}

async function executeStatus() {
  const runtime = createRuntimeForTool()
  const result = await runtime.status()
  return createToolResult('当前状态。', result)
}

function printCliJson(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

function configurePayloadOptions(command) {
  return command
    .option('--text <text>', '待签名或待验签文本')
    .option('--file <path>', '待签名或待验签文件路径')
}

function buildCliPayload(runtime, options = {}) {
  return buildPayloadInput(runtime, {
    text: typeof options.text === 'string' ? options.text : '',
    filePath: typeof options.file === 'string' ? options.file : '',
  })
}

async function runInitCommand() {
  const result = await startInstallFlow('cli_init')
  printCliJson(result)
  console.log('[veriagent-openclaw] init 已完成，如 certificateFile 不为空则表示本地证书材料已就绪。')
}

async function runStatusCommand() {
  const runtime = createRuntimeForTool()
  const result = await runtime.status()
  printCliJson(result)
}

function runListAgentsCommand() {
  const runtime = createRuntimeForTool()
  printCliJson(runtime.listAgents())
}

function runResetCommand() {
  const runtime = createRuntimeForTool()
  printCliJson(runtime.reset())
  console.log('[veriagent-openclaw] 本地状态已清理。')
}

async function runSignCommand(agentId, options = {}) {
  const normalizedAgentId = String(agentId || '').trim()
  if (!normalizedAgentId) {
    throw new Error('缺少 <agentId>')
  }

  const runtime = await ensureCertificateReady()
  const result = await runtime.sign(normalizedAgentId, buildCliPayload(runtime, options))
  printCliJson(result)
}

async function runVerifyCommand(agentId, options = {}) {
  const normalizedAgentId = String(agentId || '').trim()
  const signature = String(options.signature || '').trim()
  if (!normalizedAgentId) {
    throw new Error('缺少 <agentId>')
  }
  if (!signature) {
    throw new Error('缺少 --signature')
  }

  const runtime = await ensureCertificateReady()
  const result = await runtime.verify(normalizedAgentId, buildCliPayload(runtime, options), signature)
  printCliJson(result)
}

async function executeSign(params) {
  const agentId = String(params?.agentId || '').trim()
  if (!agentId) {
    throw new Error('缺少 agentId')
  }

  const runtime = await ensureCertificateReady()
  const result = await runtime.sign(agentId, buildPayloadInput(runtime, params))
  return createToolResult('签名完成。', result, '[veriagent-openclaw] 签名已完成，可使用返回结果中的 signature 进行验签。')
}

async function executeVerify(params) {
  const agentId = String(params?.agentId || '').trim()
  const signature = String(params?.signature || '').trim()
  if (!agentId) {
    throw new Error('缺少 agentId')
  }
  if (!signature) {
    throw new Error('缺少 signature')
  }

  const runtime = await ensureCertificateReady()
  const result = await runtime.verify(agentId, buildPayloadInput(runtime, params), signature)
  return createToolResult('验签完成。', result, '[veriagent-openclaw] 验签已完成，`valid=true` 表示签名有效。')
}

const definePluginEntry = tryLoadDefinePluginEntry()

const entry = definePluginEntry({
  id: pluginManifest.id,
  name: '@esign-cn-open-source/openclaw-veriagent',
  version: packageJson.version,

  register(api) {
    api.registerTool({
      id: 'veriagent-openclaw-install',
      name: 'VeriAgent 安装',
      factory: () => ({
        name: 'veriagent_install',
        description: '触发 VeriAgent 浏览器授权与证书安装流程。',
        parameters: buildNoArgSchema(),
        execute: executeInstall,
      }),
    })

    api.registerTool({
      id: 'veriagent-openclaw-status',
      name: 'VeriAgent 状态',
      factory: () => ({
        name: 'veriagent_status',
        description: '查看当前 VeriAgent 本地安装状态。',
        parameters: buildNoArgSchema(),
        execute: executeStatus,
      }),
    })

    api.registerTool({
      id: 'veriagent-openclaw-sign',
      name: 'VeriAgent 签名',
      factory: () => ({
        name: 'veriagent_sign',
        description: '使用本地 VeriAgent 智能体证书对文本或文件签名。',
        parameters: buildSignToolSchema(),
        execute: executeSign,
      }),
    })

    api.registerTool({
      id: 'veriagent-openclaw-verify',
      name: 'VeriAgent 验签',
      factory: () => ({
        name: 'veriagent_verify',
        description: '使用本地 VeriAgent 智能体证书对文本或文件验签。',
        parameters: buildVerifyToolSchema(),
        execute: executeVerify,
      }),
    })

    api.registerCli(
      ({ program }) => {
        const veriagent = program
          .command('veriagent')
          .description('Manage VeriAgent onboarding, local certificate state, and signing flows.')

        veriagent
          .command('init')
          .description('Start or resume VeriAgent browser authorization and certificate installation.')
          .action(runInitCommand)

        veriagent
          .command('status')
          .description('Show current VeriAgent local installation status.')
          .action(runStatusCommand)

        veriagent
          .command('list-agents')
          .description('List locally installed VeriAgent agents.')
          .action(runListAgentsCommand)

        veriagent
          .command('reset')
          .description('Clear local VeriAgent cached state.')
          .action(runResetCommand)

        configurePayloadOptions(
          veriagent
            .command('sign <agentId>')
            .description('Sign text or file with a local VeriAgent certificate.')
        ).action(runSignCommand)

        configurePayloadOptions(
          veriagent
            .command('verify <agentId>')
            .description('Verify text or file signature with a local VeriAgent certificate.')
            .requiredOption('--signature <base64>', 'Base64 signature value')
        ).action(runVerifyCommand)
      },
      {
        descriptors: [
          {
            name: 'veriagent',
            description: 'Manage VeriAgent onboarding and local certificate flows',
            hasSubcommands: true,
          },
        ],
      }
    )
  },
})

module.exports = entry
module.exports.default = entry
