import type { Env, OpenAIRequest, AnthropicRespse } from './types';
import { convertOpenAIToAnthropic, convertAnthropicToOpenAI } from './converter';
import {
  logRequestStart,
  logUpstreamRequest,
  logUpstreamResponse,
  logRequestComplete,
  logError,
  logStreamStart,
  logStreamComplete,
} from './logger';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS 处理
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'OpenAI to Anthropic Proxy (Cloudflare Workers)',
          version: '1.0.0',
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // 处理 chat completions
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  
  try {
    // 提取 API Key
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      logError(requestId, 'Missing Authorization header', Date.now() - startTime);
      return jsonResponse({ error: 'Missing Authorization header' }, 401);
    }

    const apiKey = authHeader.replace('Bearer ', '');
    if (apiKey === authHeader) {
      logError(requestId, 'Invalid Authorization header format', Date.now() - startTime);
      return jsonResponse({ error: 'Invalid Authorization header format' }, 401);
    }

    // 解析请求
    const openaiReq: OpenAIRequest = await request.json();
    
    // 记录请求详情
    logRequestStart(requestId, request, openaiReq, apiKey.substring(0, 8) + '...');

    // 解析配置
    const modelMapping = parseModelMapping(env.MODEL_MAPPING || '');
    const maxTokensMapping = parseMaxTokensMapping(env.MAX_TOKENS_MAPPING || '');
    const sessionTTLMinutes = parseInt(env.SESSION_TTL_MINUTES || '60', 10);
    const proxyMode = (env.PROXY_MODE || 'anthropic').toLowerCase();

    // 应用模型映射
    const originalModel = openaiReq.model;
    if (modelMapping.has(openaiReq.model)) {
      openaiReq.model = modelMapping.get(openaiReq.model)!;
      console.log(`🔄 [MODEL_MAPPING] ${originalModel} -> ${openaiReq.model}`);
    }

    // 判断代理模式
    if (proxyMode === 'passthrough') {
      console.log(`🔄 [MODE] Passthrough mode`);
      return handlePassthroughMode(openaiReq, apiKey, env, requestId, startTime);
    }

    // Anthropic 模式：转换格式
    console.log(`🔄 [MODE] Anthropic mode`);
    const anthropicReq = convertOpenAIToAnthropic(
      openaiReq,
      maxTokensMapping,
      apiKey,
      sessionTTLMinutes
    );
    
    // 发送到 Anthropic API
    const anthropicURL = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey.substring(0, 12) + '...',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };
    
    logUpstreamRequest(requestId, `${anthropicURL}/v1/messages`, upstreamHeaders, anthropicReq);
    
    const anthropicResp = await fetch(`${anthropicURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(anthropicReq),
    });

    logUpstreamResponse(requestId, anthropicResp.status, anthropicResp.statusText, anthropicResp.headers);
    
    if (!anthropicResp.ok) {
      const errorText = await anthropicResp.text();
      logError(requestId, `Upstream error: ${errorText}`, Date.now() - startTime, { status: anthropicResp.status });
      
      return new Response(errorText, {
        status: anthropicResp.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 流式响应
    if (openaiReq.stream) {
      logStreamStart(requestId);
      return handleStreamResponse(anthropicResp, openaiReq.model, requestId, startTime);
    }

    // 非流式响应
    const anthropicData: AnthropicResponse = await anthropicResp.json();
    const openaiResp = convertAnthropicToOpenAI(anthropicData);
    
    logRequestComplete(requestId, Date.now() - startTime, openaiResp);

    return jsonResponse(openaiResp, 200);
  } catch (error: any) {
    logError(requestId, error, Date.now() - startTime);
    return jsonResponse({ error: error.message || 'Internal Server Error' }, 500);
  }
}

async function handleStreamResponse(
  anthropicResp: Response,
  model: string,
  requestId: string,
  startTime: number
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader = anthropicResp.body!.getReader();
      const decoder = new TextDecoder();
      let messageID = '';
      let usage: any = null;
      let toolIndex = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]' || data === '') continue;

          try {
            const event = JSON.parse(data);
            const eventType = event.type;

            if (eventType === 'message_start') {
              messageID = event.message.id;
              usage = event.message.usage;

              await sendSSE(writer, encoder, {
                id: messageID,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: '' },
                    finish_reason: null,
                  },
                ],
              });
            } else if (eventType === 'content_block_start') {
              const block = event.content_block;
              if (block.type === 'tool_use') {await sendSSE(writer, encoder, {
                  id: messageID,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolIndex,
                            id: block.id,
                            type: 'function',
                            function: { name: block.name, arguments: '' },
                          },
                        ],
                      },
              finish_reason: null,
                    },
                  ],
                });
              }
            } else if (eventType === 'content_block_delta') {
              const delta = event.delta;
              if (delta.type === 'text_delta') {
                await sendSSE(writer, encoder, {
                  id: messageID,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { content: delta.text },
                      finish_reason: null,
                    },
                  ],
                });
              } else if (delta.type === 'input_json_delta') {
                await sendSSE(writer, encoder, {
                  id: messageID,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolIndex,
                            function: { arguments: delta.partial_json },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
              }
            } else if (eventType === 'content_block_stop') {
              toolIndex++;
            } else if (eventType === 'message_delta') {
              if (event.delta.stop_reason) {
                const finishReason = convertStopReason(event.delta.stop_reason);
                const finalChunk: any = {
                  id: messageID,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: finishReason,
                    },
                  ],
                };

                if (usage) {
                  finalChunk.usage = {
                    prompt_tokens: usage.input_tokens,
                    completion_tokens: usage.output_tokens,
                    total_tokens: usage.input_tokens + usage.output_tokens,
                    prompt_tokens_details: {
                      cached_tokens: usage.cache_read_input_tokens || 0,
                      audio_tokens: 0,
                    },
                    completion_tokens_details: {
                      reasoning_tokens: 0,
                      audio_tokens: 0,
                      accepted_prediction_tokens: 0,
                      rejected_prediction_tokens: 0,
                    },
                  };
                }

                await sendSSE(writer, encoder, finalChunk);
              }
            }
          } catch (e) {
            console.error('Failed to parse event:', e);
          }
        }
      }

      await writer.write(encoder.encode('data: [DONE]\n\n'));
      logStreamComplete(requestId, Date.now() - startTime);
    } catch (error) {
      console.error('Stream error:', error);
      logError(requestId, error as Error, Date.now() - startTime);
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function sendSSE(
  writer: WritableStreamDefaultWriter,
  encoder: TextEncoder,
  data: any
): Promise<void> {
  await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
}

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

function jsonResponse(data: any, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function parseModelMapping(mappingStr: string): Map<string, string> {
  const mapping = new Map<string, string>();
  if (!mappingStr) return mapping;

  const pairs = mappingStr.split(',');
  for (const pair of pairs) {
    const [source, target] = pair.split(':').map(s => s.trim());
    if (source && target) {
      mapping.set(source, target);
    }
  }

  return mapping;
}

function parseMaxTokensMapping(mappingStr: string): Map<string, number> {
  const mapping = new Map<string, number>();
  if (!mappingStr) return mapping;

  const pairs = mappingStr.split(',');
  for (const pair of pairs) {
    const [model, tokensStr] = pair.split(':').map(s => s.trim());
    const tokens = parseInt(tokensStr, 10);
    if (model && tokens > 0) {
      mapping.set(model, tokens);
    }
  }

  return mapping;
}

// 透传模式：直接转发 OpenAI 格式请求
async function handlePassthroughMode(
  openaiReq: OpenAIRequest,
  apiKey: string,
  env: Env,
  requestId: string,
  startTime: number
): Promise<Response> {
  const baseURL = env.ANTHROPIC_BASE_URL || 'https://api.openai.com';
  
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey.substring(0, 12)}...`,
  };
  
  logUpstreamRequest(requestId, `${baseURL}/v1/chat/completions`, upstreamHeaders, openaiReq);
  
  // 发送到目标 OpenAI 兼容接口
  const targetResp = await fetch(`${baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bear ${apiKey}`,
    },
    body: JSON.stringify(openaiReq),
  });

  logUpstreamResponse(requestId, targetResp.status, targetResp.statusText, targetResp.headers);

  // 直接返回响应（保持流式或非流式）
  if (openaiReq.stream) {
    logStreamStart(requestId);
    return new Response(targetResp.body, {
      status: targetResp.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  const responseData = await targetResp.json();
  logRequestComplete(requestId, Date.now() - startTime, responseData);
  
  return jsonResponse(responseData, targetResp.status);
}
