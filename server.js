import http from 'node:http'
import { URL } from 'node:url'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 动态导入 PluginsLoader
let PluginsLoader = null
try {
  const loaderModule = await import('../../lib/plugins/loader.js')
  PluginsLoader = loaderModule.default
  console.log('[OpenAI Bridge] PluginsLoader 加载成功')
} catch (err) {
  console.error('[OpenAI Bridge] 无法加载 PluginsLoader:', err.message)
}

// ============ 默认配置 ============
const DEFAULTS = {
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

const REPLY_POLL_INTERVAL = 100

// ============ 工具函数 ============

function parseApiKey(authHeader, keyPrefix) {
  if (!authHeader) return null
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token.startsWith(keyPrefix)) return null
  const qq = token.substring(keyPrefix.length)
  if (!/^\d{5,12}$/.test(qq)) return null
  return qq
}

function genId(prefix = 'chatcmpl-') {
  return prefix + crypto.randomBytes(12).toString('hex')
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(p => p.type === 'text').map(p => p.text).join('\n')
  }
  return ''
}

function extractImagesFromContent(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter(p => p.type === 'image_url')
    .map(p => p.image_url?.url || p.url)
    .filter(Boolean)
}

async function imageFileToDataURL(filePath) {
  try {
    const absPath = path.resolve(filePath)
    const buf = fssync.readFileSync(absPath)
    const ext = path.extname(absPath).toLowerCase()
    const mimeMap = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.bmp': 'image/bmp'
    }
    const mime = mimeMap[ext] || 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

async function resolveImageDataURL(imgRef) {
  if (!imgRef) return null
  if (imgRef.startsWith('data:')) return imgRef
  if (imgRef.startsWith('http://') || imgRef.startsWith('https://')) return imgRef
  let filePath = imgRef.replace(/^file:\/\//, '')
  return await imageFileToDataURL(filePath)
}

async function parseYunzaiReply(replyData) {
  const parts = []
  const text = replyData.text || ''
  const imgRegex = /!\[img\]\(([^)]+)\)/g
  let match
  let lastIndex = 0
  const textFragments = []

  while ((match = imgRegex.exec(text)) !== null) {
    const before = text.substring(lastIndex, match.index).trim()
    if (before) textFragments.push(before)
    const dataURL = await resolveImageDataURL(match[1])
    if (dataURL) parts.push({ type: 'image_url', image_url: { url: dataURL } })
    lastIndex = match.index + match[0].length
  }
  const remaining = text.substring(lastIndex).trim()
  if (remaining) textFragments.push(remaining)

  const cleanText = textFragments.join('\n').trim()
  if (cleanText) parts.unshift({ type: 'text', text: cleanText })

  for (const img of (replyData.images || [])) {
    const dataURL = await resolveImageDataURL(img)
    if (dataURL) parts.push({ type: 'image_url', image_url: { url: dataURL } })
  }

  if (replyData.audio) {
    const dataURL = await resolveImageDataURL(replyData.audio)
    if (dataURL) parts.push({ type: 'audio_url', audio_url: { url: dataURL } })
  }

  if (parts.length === 0) parts.push({ type: 'text', text: '' })
  return parts
}

// ============ 主类 ============

export default class OpenAIHTTPServer {
  constructor(pluginInstance, cfg = {}) {
    this.plugin = pluginInstance
    this.cfg = { ...DEFAULTS, ...cfg }
    this.port = this.cfg.port
    this.server = null
    this.running = false
    this.totalRequests = 0
    this.activeConnections = 0
    this.requestQueue = []
    this.processing = false
  }

  log(...args) {
    logger.mark('[OpenAI Bridge]', ...args)
  }

  debug(...args) {
    if (this.cfg.logLevel === 'debug') {
      logger.debug('[OpenAI Bridge]', ...args)
    }
  }

  async start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res))
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`[OpenAI Bridge] 端口 ${this.port} 已被占用`)
      }
      throw err
    })
    await new Promise((resolve, reject) => {
      this.server.listen(this.port, this.cfg.bindHost, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    this.running = true
  }

  async stop() {
    if (this.server) {
      this.running = false
      await new Promise(r => this.server.close(r))
    }
  }

  getStats() {
    return { totalRequests: this.totalRequests, activeConnections: this.activeConnections }
  }

  // ============ HTTP 请求处理 ============

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathname = url.pathname

    this.debug(`${req.method} ${pathname}`)

    if (this.cfg.cors) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      if (pathname === '/v1/models' && req.method === 'GET') {
        return this.handleModels(req, res)
      }
      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        return await this.handleChatCompletions(req, res)
      }
      if (pathname === '/' || pathname === '/v1') {
        return this.sendJson(res, 200, {
          message: 'Yunzai OpenAI Bridge',
          version: '1.0.0',
          model: this.cfg.modelName,
          pluginsLoaderReady: !!PluginsLoader,
          endpoints: ['GET /v1/models', 'POST /v1/chat/completions']
        })
      }
      this.sendJson(res, 404, { error: { message: `Not Found: ${pathname}`, type: 'invalid_request_error' } })
    } catch (err) {
      logger.error('[OpenAI Bridge] 请求处理错误:', err)
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: { message: err.message, type: 'api_error' } })
      }
    }
  }

  handleModels(_req, res) {
    this.sendJson(res, 200, {
      object: 'list',
      data: [{
        id: this.cfg.modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'yunzai-openai-bridge',
        root: this.cfg.modelId,
        parent: null
      }]
    })
  }

  // ============ /v1/chat/completions ============

  async handleChatCompletions(req, res) {
    this.totalRequests++
    this.activeConnections++
    const reqId = this.totalRequests

    try {
      // 1. 认证
      const qq = parseApiKey(req.headers['authorization'], this.cfg.keyPrefix)
      if (!qq) {
        this.log(`[#${reqId}] ❌ 认证失败，Key 格式错误`)
        this.sendJson(res, 401, {
          error: { message: `Invalid API Key. Format: ${this.cfg.keyPrefix}<QQ号>`, type: 'invalid_request_error' }
        })
        return
      }
      this.log(`[#${reqId}] ✅ 认证成功 QQ=${qq}`)

      // 2. 解析 body
      const body = await this.readBody(req)
      let params
      try {
        params = JSON.parse(body)
      } catch {
        this.log(`[#${reqId}] ❌ JSON 解析失败`)
        this.sendJson(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } })
        return
      }

      const { messages, model = this.cfg.modelId, stream = false } = params

      if (!Array.isArray(messages) || messages.length === 0) {
        this.sendJson(res, 400, { error: { message: 'messages required', type: 'invalid_request_error' } })
        return
      }

      const lastUserMsg = this.getLastUserMessage(messages)
      if (!lastUserMsg) {
        this.sendJson(res, 400, { error: { message: 'No user message', type: 'invalid_request_error' } })
        return
      }

      const prompt = lastUserMsg.text
      const imageUrls = lastUserMsg.images

      this.log(`[#${reqId}] 📩 QQ=${qq} | "${prompt.substring(0, 100)}" | images=${imageUrls.length} | stream=${stream}`)

      // 3. 处理
      if (stream) {
        await this.processStreamRequest(res, reqId, qq, prompt, imageUrls, model)
      } else {
        await this.processNormalRequest(res, reqId, qq, prompt, imageUrls, model)
      }

      this.log(`[#${reqId}] ✅ 请求完成`)
    } catch (err) {
      logger.error(`[OpenAI Bridge] [#${reqId}] ❌ 错误:`, err)
      if (!res.headersSent) {
        this.sendJson(res, 500, { error: { message: err.message, type: 'api_error' } })
      }
    } finally {
      this.activeConnections--
    }
  }

  getLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'user') {
        return { text: extractTextFromContent(msg.content), images: extractImagesFromContent(msg.content) }
      }
    }
    return null
  }

  // ============ 普通请求 ============

  async processNormalRequest(res, reqId, qq, prompt, imageUrls, model) {
    this.log(`[#${reqId}] 🔄 发送到 Yunzai...`)
    const result = await this.sendToYunzai(reqId, qq, prompt, imageUrls)
    this.log(`[#${reqId}] 📤 收到回复: text=${(result.text || '').length}B images=${result.images.length}`)

    const content = await parseYunzaiReply(result)
    const hasMultimodal = content.some(p => p.type !== 'text')
    let responseContent = (!hasMultimodal && content.length === 1 && content[0].type === 'text')
      ? content[0].text
      : content

    this.sendJson(res, 200, {
      id: genId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: responseContent }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 2),
        completion_tokens: Math.ceil((result.text || '').length / 2),
        total_tokens: Math.ceil((prompt.length + (result.text || '').length) / 2)
      }
    })
  }

  // ============ 流式请求 ============

  async processStreamRequest(res, reqId, qq, prompt, imageUrls, model) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const chatId = genId()
    const created = Math.floor(Date.now() / 1000)

    this.writeSSE(res, {
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
    })

    this.log(`[#${reqId}] 🔄 发送到 Yunzai (stream)...`)
    const result = await this.sendToYunzai(reqId, qq, prompt, imageUrls)
    this.log(`[#${reqId}] 📤 收到回复 (stream)`)
    const content = await parseYunzaiReply(result)

    for (const part of content) {
      if (part.type === 'text') {
        const chunks = this.splitTextForStreaming(part.text || '')
        for (const chunk of chunks) {
          this.writeSSE(res, {
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }]
          })
        }
      } else if (part.type === 'image_url') {
        this.writeSSE(res, {
          id: chatId, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: `\n![image](${part.image_url?.url})\n` }, finish_reason: null }]
        })
      } else if (part.type === 'audio_url') {
        this.writeSSE(res, {
          id: chatId, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: `\n[audio](${part.audio_url?.url})\n` }, finish_reason: null }]
        })
      }
    }

    this.writeSSE(res, {
      id: chatId, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })
    res.write('data: [DONE]\n\n')
    res.end()
  }

  splitTextForStreaming(text, maxChunk = 100) {
    if (!text) return []
    const chunks = []
    const lines = text.split('\n')
    let current = ''
    for (const line of lines) {
      if (current.length + line.length > maxChunk && current) {
        chunks.push(current + '\n')
        current = line
      } else {
        current = current ? current + '\n' + line : line
      }
    }
    if (current) chunks.push(current)
    return chunks
  }

  writeSSE(res, data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`) }
    catch { /* closed */ }
  }

  // ============ Yunzai 交互核心 ============

  async sendToYunzai(reqId, qq, prompt, imageUrls = []) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ reqId, qq, prompt, imageUrls, resolve, reject })
      this.processQueue()
    })
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) return
    this.processing = true

    while (this.requestQueue.length > 0) {
      const task = this.requestQueue.shift()
      try {
        const result = await this.doSendToYunzai(task.reqId, task.qq, task.prompt, task.imageUrls)
        task.resolve(result)
      } catch (err) {
        task.reject(err)
      }
    }

    this.processing = false
  }

  async doSendToYunzai(reqId, qq, prompt, imageUrls = []) {
    // 检查 PluginsLoader
    if (!PluginsLoader) {
      this.log(`[#${reqId}] ❌ PluginsLoader 未加载`)
      throw new Error('PluginsLoader not loaded. Check Yunzai startup logs.')
    }

    // 检查 PluginsLoader 是否有 deal 方法
    if (typeof PluginsLoader.deal !== 'function') {
      this.log(`[#${reqId}] ❌ PluginsLoader.deal 不是函数: ${typeof PluginsLoader.deal}`)
      throw new Error('PluginsLoader.deal is not available')
    }

    this.log(`[#${reqId}] 🔧 PluginsLoader 就绪，插件数: ${PluginsLoader.priority?.length || 'unknown'}`)

    const replyData = { text: '', images: [], audio: null }

    // 构造消息
    const messageSegments = [{ type: 'text', text: prompt }]
    for (const url of imageUrls) {
      messageSegments.push({ type: 'image', url, file: url })
    }

    // 构造 fake event
    const e = {
      test: true,
      self_id: 10000,
      time: Math.floor(Date.now() / 1000),
      post_type: 'message',
      message_type: 'private',
      sub_type: 'normal',
      group_id: 826198224,
      group_name: 'OpenAI Bridge',
      user_id: String(qq),
      anonymous: null,
      message: messageSegments,
      raw_message: prompt,
      font: '微软雅黑',
      sender: {
        user_id: String(qq),
        nickname: `OpenAI-${qq}`,
        card: '',
        sex: 'unknown',
        age: 0,
        area: 'unknown',
        level: 1,
        role: 'owner',
        title: ''
      },
      group: { mute_left: 0 },
      friend: {},
      message_id: genId('openai-')
    }

    e.group.sendMsg = (msg) => {
      this.debug(`[#${reqId}] group.sendMsg 被调用`)
      this.collectReply(replyData, msg)
    }

    e.reply = async (msg) => {
      this.log(`[#${reqId}] 💬 reply 被调用: type=${typeof msg} msg=${typeof msg === 'string' ? msg.substring(0, 80) : msg?.type || 'unknown'}`)
      if (!msg) return false
      await this.collectReply(replyData, msg)
      return { message_id: e.message_id }
    }

    // 调用 PluginsLoader
    this.log(`[#${reqId}] 🚀 调用 PluginsLoader.deal()...`)
    try {
      const dealResult = PluginsLoader.deal(e)
      if (dealResult && typeof dealResult.then === 'function') {
        await dealResult
      }
      this.log(`[#${reqId}] ✅ PluginsLoader.deal() 完成`)
    } catch (err) {
      logger.error(`[OpenAI Bridge] [#${reqId}] PluginsLoader.deal() 异常:`, err)
    }

    // 等待回复
    this.log(`[#${reqId}] ⏳ 等待回复... (超时 ${this.cfg.replyTimeout}ms)`)
    const startTime = Date.now()
    const timeout = this.cfg.replyTimeout
    while (!replyData.text && replyData.images.length === 0 && !replyData.audio) {
      if (Date.now() - startTime > timeout) {
        this.log(`[#${reqId}] ⏰ 回复超时`)
        replyData.text = '⏰ 等待回复超时，请稍后重试'
        break
      }
      await new Promise(r => setTimeout(r, REPLY_POLL_INTERVAL))
    }

    this.log(`[#${reqId}] 📦 最终回复: text="${(replyData.text || '').substring(0, 100)}" images=${replyData.images.length}`)
    return replyData
  }

  // ============ 回复收集 ============

  async collectReply(replyData, msg) {
    if (!msg) return

    if (typeof msg === 'string') {
      replyData.text += msg + '\n'
      return
    }

    if (Array.isArray(msg)) {
      for (const item of msg) {
        await this.collectReply(replyData, item)
      }
      return
    }

    if (msg.type === 'image') {
      try {
        const imgRef = await this.resolveImageFile(msg)
        if (imgRef) {
          replyData.images.push(imgRef)
        }
      } catch (err) {
        logger.error('[OpenAI Bridge] Image error:', err)
      }
      return
    }

    if (msg.type === 'record' || msg.type === 'audio') {
      try {
        const audioRef = await this.resolveAudioFile(msg)
        if (audioRef) replyData.audio = audioRef
      } catch (err) {
        logger.error('[OpenAI Bridge] Audio error:', err)
      }
      return
    }

    if (msg.type === 'text' && msg.text) {
      replyData.text += msg.text + '\n'
      return
    }

    this.debug('未处理的 msg 类型:', msg.type, JSON.stringify(msg).substring(0, 200))
  }

  async resolveImageFile(msg) {
    if (!msg.file) return null
    if (msg.file instanceof Buffer) {
      const mime = msg.as_jpg ? 'image/jpeg' : 'image/png'
      return `data:${mime};base64,${msg.file.toString('base64')}`
    }
    if (typeof msg.file === 'string') {
      if (msg.file.startsWith('base64://')) return `data:image/png;base64,${msg.file.replace(/^base64:\/\//, '')}`
      if (msg.file.startsWith('file://')) return await imageFileToDataURL(msg.file.replace(/^file:\/\//, ''))
      if (msg.file.startsWith('http://') || msg.file.startsWith('https://')) return msg.file
      return await imageFileToDataURL(msg.file)
    }
    return null
  }

  async resolveAudioFile(msg) {
    if (!msg.file) return null
    if (msg.file instanceof Buffer) return `data:audio/ogg;base64,${msg.file.toString('base64')}`
    if (typeof msg.file === 'string') {
      if (msg.file.startsWith('base64://')) return `data:audio/ogg;base64,${msg.file.replace(/^base64:\/\//, '')}`
      if (msg.file.startsWith('file://')) {
        try {
          const buf = fssync.readFileSync(path.resolve(msg.file.replace(/^file:\/\//, '')))
          return `data:audio/ogg;base64,${buf.toString('base64')}`
        } catch { return null }
      }
      if (msg.file.startsWith('http://') || msg.file.startsWith('https://')) return msg.file
    }
    return null
  }

  // ============ HTTP 工具 ============

  readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', chunk => {
        size += chunk.length
        if (size > this.cfg.maxBodySize) {
          reject(new Error('Body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString()))
      req.on('error', reject)
    })
  }

  sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
}
