# Yunzai OpenAI Bridge

将 Yunzai-Bot 暴露为标准 OpenAI 兼容 API，支持 Cherry Studio、NextChat、LobeChat 等工具直接调用。

## 功能

- 标准 `POST /v1/chat/completions` 接口
- **多用户** — API Key 编码 QQ 号，各用户独立上下文
- **多模态** — 文本 + 图片(Vision) + 语音
- **流式输出** — SSE `stream: true`
- 请求队列串行化，保证 Yunzai 稳定性

## 安装

```bash
# 复制到 Yunzai 插件目录
cp -r openai-bridge /path/to/Yunzai-Bot/user_plugins/openai-bridge

# 复制配置文件
cp openai-bridge/config/openai_bridge.yaml /path/to/Yunzai-Bot/config/config/openai_bridge.yaml

# 重启 Yunzai
```

## 配置

`config/config/openai_bridge.yaml`：

```yaml
port: 3000                    # 监听端口（被占用请换一个）
bindHost: 0.0.0.0             # 监听地址
cors: true                    # 跨域
maxBodySize: 10485760         # 最大请求体 10MB

modelId: yunzai-bot           # 模型 ID
modelName: Yunzai-Bot         # 模型名称

keyPrefix: sk-trss-a7f3e91b4c82d056-   # Key 前缀

replyTimeout: 120000          # 回复超时 120s
logLevel: info                # 日志级别
```

管理员命令：
```
#openai-bridge状态    # 查看运行状态
```

## API Key

格式：`{keyPrefix}<QQ号>`

```
sk-trss-a7f3e91b4c82d056-12345678
                        └─ QQ号
```

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | 聊天补全 |

### 纯文本

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-trss-a7f3e91b4c82d056-12345678" \
  -d '{"model":"yunzai-bot","messages":[{"role":"user","content":"#uid"}]}'
```

### 多模态 (Vision)

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-trss-a7f3e91b4c82d056-12345678" \
  -d '{
    "model":"yunzai-bot",
    "messages":[{
      "role":"user",
      "content":[
        {"type":"text","text":"#角色面板"},
        {"type":"image_url","image_url":{"url":"https://example.com/img.jpg"}}
      ]
    }]
  }'
```

### 流式

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-trss-a7f3e91b4c82d056-12345678" \
  -d '{"model":"yunzai-bot","messages":[{"role":"user","content":"#帮助"}],"stream":true}'
```

## Cherry Studio 配置

1. 模型设置 → 添加自定义模型
2. 填写：
   - **模型名称**: `yunzai-bot`
   - **API Base URL**: `http://<服务器IP>:3000/v1`
   - **API Key**: `sk-trss-a7f3e91b4c82d056-<你的QQ号>`

## 原理

核心消息转换提取自 [yunzai-bot-web](https://github.com/117503445/yunzai-bot-web)：

1. 解析 API Key → 提取 QQ 号
2. 构造 fake QQ 消息事件
3. `PluginsLoader.deal(e)` → Yunzai 插件处理
4. 捕获 `e.reply()` 回调中的文本/图片/语音
5. 转换为 OpenAI 格式返回
