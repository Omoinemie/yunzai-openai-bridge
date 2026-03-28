import plugin from '../../lib/plugins/plugin.js'
import OpenAIHTTPServer from './server.js'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

// 全局单例锁：防止插件被多次加载时重复启动 HTTP 服务
let globalServer = null
let initPromise = null

export class OpenAIBridge extends plugin {
  constructor() {
    super({
      name: 'OpenAI Bridge',
      dsc: '将 Yunzai 暴露为 OpenAI 兼容 API，供 Cherry Studio 等工具调用',
      event: 'message',
      priority: 9999,
      rule: [
        { reg: '^#openai-bridge状态$', fnc: 'showStatus', permission: 'master' }
      ]
    })
  }

  /** 读取配置 */
  static getConfig() {
    const def = {
      port: 3000,
      replyTimeout: 120000,
      modelName: 'yunzai-bot',
      modelId: 'yunzai-bot',
      keyPrefix: 'sk-trss-a7f3e91b4c82d056-',
      cors: true,
      maxBodySize: 10485760,
      bindHost: '0.0.0.0',
      logLevel: 'info'
    }
    try {
      const pluginDir = path.dirname(new URL(import.meta.url).pathname)
      const paths = [
        path.join(pluginDir, 'config.yaml'),
        './user_plugins/openai-bridge/config.yaml',
        './plugins/openai-bridge/config.yaml',
        './plugins/openai/config.yaml'
      ]
      for (const cfgPath of paths) {
        if (fs.existsSync(cfgPath)) {
          const userCfg = YAML.parse(fs.readFileSync(cfgPath, 'utf-8'))
          logger.mark(`[OpenAI Bridge] 加载配置: ${cfgPath}`)
          return { ...def, ...userCfg }
        }
      }
    } catch (e) {
      logger.warn('[OpenAI Bridge] 配置文件读取失败，使用默认配置:', e.message)
    }
    return def
  }

  async init() {
    // 如果服务已在运行，直接跳过
    if (globalServer && globalServer.running) {
      logger.mark('[OpenAI Bridge] 服务已在运行，跳过')
      return
    }

    // 如果正在初始化中，等待其完成（防止并发 init）
    if (initPromise) {
      logger.mark('[OpenAI Bridge] 正在初始化，等待...')
      await initPromise
      return
    }

    // 标记初始化开始
    initPromise = (async () => {
      logger.mark('[OpenAI Bridge] 初始化中...')
      const cfg = OpenAIBridge.getConfig()
      try {
        const server = new OpenAIHTTPServer(this, cfg)
        await server.start()
        globalServer = server
        this.server = server
        logger.mark(`[OpenAI Bridge] ✅ API 服务已启动`)
        logger.mark(`[OpenAI Bridge] 端口: ${cfg.port} | 模型: ${cfg.modelName}`)
        logger.mark(`[OpenAI Bridge] API Base: http://${cfg.bindHost}:${cfg.port}/v1`)
        logger.mark(`[OpenAI Bridge] Key 格式: ${cfg.keyPrefix}<QQ号>`)
      } catch (err) {
        logger.error('[OpenAI Bridge] 启动失败:', err.message)
        initPromise = null // 允许重试
        throw err
      }
    })()

    await initPromise
  }

  async showStatus(e) {
    const srv = globalServer
    const status = srv?.running ? '✅ 运行中' : '❌ 已停止'
    const cfg = OpenAIBridge.getConfig()
    const stats = srv?.getStats() || {}
    await e.reply([
      '【OpenAI Bridge 状态】',
      `状态: ${status}`,
      `端口: ${cfg.port}`,
      `模型: ${cfg.modelName} (${cfg.modelId})`,
      `总请求数: ${stats.totalRequests || 0}`,
      `活跃连接: ${stats.activeConnections || 0}`,
      `Key 格式: ${cfg.keyPrefix}<QQ号>`,
      `API Base: http://<IP>:${cfg.port}/v1`
    ].join('\n'))
  }
}

export class openAIBridge extends OpenAIBridge {}
