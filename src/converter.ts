import type {
  OpenAIRequest,
  OpenAIMessage,
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContent,
  AnthropicSystemBlock,
  CacheControl,
  AnthropicResponse,
  OpenAIResponse,
  ToolCall,
} from './types';

// 生成稳定的 user_id（基于 API Key）
export function generateStableUserID(apiKey: string, clientUser: string, sessionTTLMinutes: number = 60): string {
  const seed = clientUser ? `${apiKey}_${clientUser}` : apiKey;
  const timeWindow = Math.floor(Date.now() / (sessionTTLMinutes * 60 * 1000));
  
  return `user_${hashString(seed)}_account__session_${hashString(`${seed}_session_${timeWindow}`)}`;
}

// 简单的字符串哈希函数
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(16, '0');
}

// 转换 OpenAI 请求到 Anthropic 格式
export function convertOpenAIToAnthropic(
  req: OpenAIRequest,
  maxTokensMapping: Map<string, number>,
  apiKey: string,
  sessionTTLMinutes: number = 60
): AnthropicRequest {
  // 转换工具定义
  const claudeTools = req.tools?.map(tool => ({
    name: tool.function.name,
    description: tool.function.description || '',
    input_schema: {
      type: tool.function.parameters.type || 'object',
      properties: tool.function.parameters.properties,
      required: tool.function.parameters.required,
      ...Object.fromEntries(
        Object.entries(tool.function.parameters).filter(
          ([key]) => !['type', 'properties', 'required'].includes(key)
        )
      ),
    },
  })) || [];

  const anthReq: AnthropicRequest = {
    model: req.model,
    max_tokens: req.max_tokens || getDefaultMaxTokens(req.model, maxTokensMapping),
    temperature: req.temperature,
    top_p: req.top_p,
    stream: req.stream,
    tools: claudeTools,
    messages: [],
    metadata: {
      user_id: generateStableUserID(apiKey, req.user || '', sessionTTLMinutes),
    },
  };

  // 格式化消息：合并连续相同角色的消息
  const formatMessages: OpenAIMessage[] = [];
  let lastMessage: OpenAIMessage | null = null;

  for (const message of req.messages) {
    const msg = { ...message, role: message.role || 'user' };

    // 合并连续相同角色的消息（tool 除外）
    if (lastMessage && lastMessage.role === msg.role && msg.role !== 'tool') {
      if (typeof lastMessage.content === 'string' && typeof msg.content === 'string') {
        msg.content = `${lastMessage.content} ${msg.content}`.trim();
        formatMessages.pop();
      }
    }

    // 如果 content 是 null，设置为占位符
    if (msg.content === null || msg.content === undefined) {
      msg.content = '...';
    }

    formatMessages.push(msg);
    lastMessage = msg;
  }

  // 转换消息
  const claudeMessages: AnthropicMessage[] = [];
  const systemMessages: AnthropicSystemBlock[] = [];
  let isFirstMessage = true;

  for (const message of formatMessages) {
    // 提取 system 消息
    if (message.role === 'system') {
      if (typeof message.content === 'string') {
        systemMessages.push({
          type: 'text',
          text: message.content,
        });
      } else if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'text' && item.text) {
            systemMessages.push({
              type: 'text',
              text: item.text,
            });
          }
        }
      }
      continue;
    }

    // 确保第一条消息是 user
    if (isFirstMessage) {
      isFirstMessage = false;
      if (message.role !== 'user') {
        claudeMessages.push({
          role: 'user',
          content: [{ type: 'text', text: '...' }],
        });
      }
    }

    const anthMsg: AnthropicMessage = {
      role: message.role,
      content: '',
    };

    // 处理 tool 结果
    if (message.role === 'tool' && message.tool_call_id) {
      const toolResult: AnthropicContent = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
      };

      // 尝试合并到上一条 user 消息
      if (claudeMessages.length > 0 && claudeMessages[claudeMessages.length - 1].role === 'user') {
        const lastMsg = claudeMessages[claudeMessages.length - 1];
        
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = [{ type: 'text', text: lastMsg.content }];
        }

        if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push(toolResult);
          continue;
        }
      } else {
        anthMsg.role = 'user';
        anthMsg.content = [toolResult];
      }
    } else if (typeof message.content === 'string' && (!message.tool_calls || message.tool_calls.length === 0)) {
      // 纯文本消息
      anthMsg.content = message.content;
    } else {
      // 复杂内容或有 tool_calls
      const anthContents: AnthropicContent[] = [];

      // 转换 content
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (item.type === 'text' && item.text) {
            anthContents.push({
              type: 'text',
              text: item.text,
            });
          } else if (item.type === 'image_url' && item.image_url) {
            anthContents.push({
              type: 'image',
              source: {
                type: 'url',
                url: item.image_url.url,
              },
            });
          }
        }
      }

      // 添加 tool_calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          let input: any = {};

          if (toolCall.function.arguments && toolCall.function.arguments !== '{}') {
            try {
              input = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              console.error('Failed to parse tool call arguments:', e);
            }
          }

          anthContents.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          });
        }
      }

      if (anthContents.length > 0) {
        anthMsg.content = anthContents;
      } else {
        continue;
      }
    }

    claudeMessages.push(anthMsg);
  }

  // 添加 system 消息并设置 cache_control
  if (systemMessages.length > 0) {
    systemMessages[systemMessages.length - 1].cache_control = {
      type: 'ephemeral',
      ttl: '1h',
    };
    anthReq.system = systemMessages;
  }

  // 在倒数第2条 assistant 消息添加 cache_control
  if (claudeMessages.length >= 2) {
    const secondLast = claudeMessages[claudeMessages.length - 2];
    if (secondLast.role === 'assistant') {
      addCacheControlToMessage(secondLast);
    }
  }

  anthReq.messages = claudeMessages;
  return anthReq;
}

// 添加缓存控制到消息
function addCacheControlToMessage(msg: AnthropicMessage): void {
  if (Array.isArray(msg.content)) {
    if (msg.content.length > 0) {
      msg.content[msg.content.length - 1].cache_control = {
        type: 'ephemeral',
        ttl: '1h',
      };
    }
  } else if (typeof msg.content === 'string' && msg.content) {
    msg.content = [
      {
        type: 'text',
        text: msg.content,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ];
  }
}

// 获取默认的 max_tokens
function getDefaultMaxTokens(model: string, maxTokensMapping: Map<string, number>): number {
  // 优先使用用户配置的映射
  if (maxTokensMapping.has(model)) {
    return maxTokensMapping.get(model)!;
  }

  const modelLower = model.toLowerCase();

  // Claude 系列
  if (modelLower.includes('opus-4')) return 16384;
  if (modelLower.includes('opus')) return 8192;
  if (modelLower.includes('sonnet')) return 8192;
  if (modelLower.includes('haiku')) return 4096;
  
  // GPT 系列
  if (modelLower.includes('gpt-4')) return 8192;
  if (modelLower.includes('gpt-3.5')) return 4096;
  if (modelLower.includes('gpt-4o')) return 16384;
  
  // MiniMax 系列
  if (modelLower.includes('minimax')) return 8192;
  if (modelLower.includes('abab')) return 8192;
  
  // DeepSeek 系列
  if (modelLower.includes('deepseek')) return 8192;
  
  // Qwen 系列
  if (modelLower.includes('qwen')) return 8192;
  if (modelLower.includes('qwq')) return 32768;
  
  // Gemini 系列
  if (modelLower.includes('gemini-pro')) return 8192;
  if (modelLower.includes('gemini-1.5')) return 8192;
  if (modelLower.includes('gemini-2')) return 8192;
  
  // GLM 系列
  if (modelLower.includes('glm-4')) return 8192;
  if (modelLower.includes('glm-3')) return 4096;
  
  // 默认值
  return 8192;
}

// 转换 Anthropic 响应到 OpenAI 格式
export function convertAnthropicToOpenAI(anthResp: AnthropicResponse): OpenAIResponse {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const content of anthResp.content) {
    if (content.type === 'text' && content.text) {
      textParts.push(content.text);
    } else if (content.type === 'tool_use') {
      toolCalls.push({
        id: content.id!,
        type: 'function',
        function: {
          name: content.name!,
          arguments: JSON.stringify(content.input || {}),
        },
      });
    }
  }

  return {
    id: anthResp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthResp.model,
    choices: [
      {
        index: 0,
        message: {
          role: anthResp.role,
          content: textParts.join(''),
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: convertStopReason(anthResp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: anthResp.usage.input_tokens,
      completion_tokens: anthResp.usage.output_tokens,
      total_tokens: anthResp.usage.input_tokens + anthResp.usage.output_tokens,
      prompt_tokens_details: {
        cached_tokens: anthResp.usage.cache_read_input_tokens,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        audio_tokens: 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
      },
    },
    service_tier: 'default',
  };
}

// 转换停止原因
function convertStopReason(reason: string): string {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason;
  }
}
