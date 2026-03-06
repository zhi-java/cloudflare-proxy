import type { Env, OpenAIRequest, AnthropicResponse } from './types';
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

// 重试配置和熔断器状态
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  retryableStatuses: number[];
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  timeoutMs: number;
}

interface AppConfig {
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
  requestTimeoutMs: number;
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
}

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 8000,
  retryableStatuses: [429, 502, 503, 504],
};

const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  timeoutMs: 30000,
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

// 简单的内存熔断器（生产环境建议使用 KV 存储）
const circuitBreakers = new Map<string, CircuitBreakerState>();

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRetryableStatuses(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const list = value
    .split(',')
    .map(item => Number.parseInt(item.trim(), 10))
    .filter(status => Number.isFinite(status) && status >= 400 && status <= 599);
  return list.length > 0 ? list : fallback;
}

function parseLogLevel(value: string | undefined): 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' {
  const normalized = (value || 'INFO').toUpperCase();
  if (normalized === 'DEBUG' || normalized === 'INFO' || normalized === 'WARN' || normalized === 'ERROR') {
    return normalized;
  }
  return 'INFO';
}

function getUpstreamBaseURL(env: Env, fallback: string): string {
  return env.UPSTREAM_BASE_URL || env.ANTHROPIC_BASE_URL || fallback;
}

function buildAppConfig(env: Env): AppConfig {
  return {
    retry: {
      maxRetries: parsePositiveInt(env.MAX_RETRIES, DEFAULT_RETRY_CONFIG.maxRetries),
      baseDelay: parsePositiveInt(env.RETRY_BASE_DELAY, DEFAULT_RETRY_CONFIG.baseDelay),
      maxDelay: parsePositiveInt(env.RETRY_MAX_DELAY, DEFAULT_RETRY_CONFIG.maxDelay),
      retryableStatuses: parseRetryableStatuses(env.RETRYABLE_STATUSES, DEFAULT_RETRY_CONFIG.retryableStatuses),
    },
    circuitBreaker: {
      failureThreshold: parsePositiveInt(env.CIRCUIT_BREAKER_FAILURE_THRESHOLD, DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold),
      timeoutMs: parsePositiveInt(env.CIRCUIT_BREAKER_TIMEOUT, DEFAULT_CIRCUIT_BREAKER_CONFIG.timeoutMs),
    },
    requestTimeoutMs: parsePositiveInt(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}

function shouldLog(logLevel: AppConfig['logLevel'], level: AppConfig['logLevel']): boolean {
  const priority: Record<AppConfig['logLevel'], number> = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
  };
  return priority[level] >= priority[logLevel];
}

function sanitizeForLog<T>(input: T): T {
  const json = JSON.stringify(input);
  if (!json || json.length <= 12000) {
    return input;
  }

  return {
    _truncated: true,
    preview: `${json.slice(0, 12000)}...[truncated]`,
  } as T;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('request-timeout'), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function validateOpenAIRequest(openaiReq: OpenAIRequest): string | null {
  if (!openaiReq || typeof openaiReq !== 'object') {
    return 'Invalid request body';
  }

  if (!openaiReq.model || typeof openaiReq.model !== 'string') {
    return 'Field "model" is required and must be a string';
  }

  if (!Array.isArray(openaiReq.messages) || openaiReq.messages.length === 0) {
    return 'Field "messages" is required and must be a non-empty array';
  }

  return null;
}

function safeApiKeyPrefix(apiKey: string): string {
  if (!apiKey) return 'empty';
  return `${apiKey.slice(0, 8)}...`;
}

function logWithLevel(config: AppConfig, level: AppConfig['logLevel'], message: string): void {
  if (!shouldLog(config.logLevel, level)) {
    return;
  }

  if (level === 'ERROR') {
    console.error(message);
    return;
  }

  if (level === 'WARN') {
    console.warn(message);
    return;
  }

  console.log(message);
}

function logDebug(config: AppConfig, message: string): void {
  logWithLevel(config, 'DEBUG', message);
}

function logInfo(config: AppConfig, message: string): void {
  logWithLevel(config, 'INFO', message);
}

function logWarn(config: AppConfig, message: string): void {
  logWithLevel(config, 'WARN', message);
}

function logErr(config: AppConfig, message: string): void {
  logWithLevel(config, 'ERROR', message);
}

function getCircuitBreakerKey(baseURL: string): string {
  return `cb_${new URL(baseURL).hostname}`;
}

function shouldRetry(status: number, attempt: number, config: RetryConfig): boolean {
  return attempt < config.maxRetries && config.retryableStatuses.includes(status);
}

function calculateDelay(attempt: number, config: RetryConfig): number {
  const delay = Math.min(config.baseDelay * Math.pow(2, attempt), config.maxDelay);
  // 添加随机抖动，避免惊群效应
  return delay + Math.random() * 1000;
}

function updateCircuitBreaker(key: string, success: boolean, cbConfig: CircuitBreakerConfig): void {
  const now = Date.now();
  let state = circuitBreakers.get(key) || { failures: 0, lastFailureTime: 0, state: 'CLOSED' };

  if (success) {
    state.failures = 0;
    state.state = 'CLOSED';
  } else {
    state.failures++;
    state.lastFailureTime = now;

    if (state.failures >= cbConfig.failureThreshold) {
      state.state = 'OPEN';
    }
  }

  circuitBreakers.set(key, state);
}

function canMakeRequest(key: string, cbConfig: CircuitBreakerConfig): boolean {
  const state = circuitBreakers.get(key);
  if (!state || state.state === 'CLOSED') {
    return true;
  }

  const now = Date.now();
  if (state.state === 'OPEN' && now - state.lastFailureTime > cbConfig.timeoutMs) {
    state.state = 'HALF_OPEN';
    circuitBreakers.set(key, state);
    return true;
  }

  return state.state !== 'OPEN';
}

// 带重试和熔断器的请求函数
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  requestId: string,
  appConfig: AppConfig,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<Response> {
  const cbKey = getCircuitBreakerKey(url);

  if (!canMakeRequest(cbKey, appConfig.circuitBreaker)) {
    logErr(appConfig, `🚫 [CIRCUIT_BREAKER] ${requestId}: Circuit breaker is OPEN for ${new URL(url).hostname}`);
    throw new Error('Circuit breaker is open');
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = calculateDelay(attempt - 1, retryConfig);
        logInfo(appConfig, `⏳ [RETRY_DELAY] ${requestId}: Attempt ${attempt}, waiting ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      logDebug(appConfig, `🔄 [FETCH_ATTEMPT] ${requestId}: Attempt ${attempt + 1}/${retryConfig.maxRetries + 1}`);

      const response = await fetchWithTimeout(url, options, appConfig.requestTimeoutMs);

      if (!response.ok && shouldRetry(response.status, attempt, retryConfig)) {
        logWarn(appConfig, `⚠️ [RETRY_NEEDED] ${requestId}: Status ${response.status}, will retry`);
        updateCircuitBreaker(cbKey, false, appConfig.circuitBreaker);
        continue;
      }

      updateCircuitBreaker(cbKey, response.ok, appConfig.circuitBreaker);

      if (response.ok) {
        logInfo(appConfig, `✅ [FETCH_SUCCESS] ${requestId}: Succeeded on attempt ${attempt + 1}`);
      }

      return response;
    } catch (error: any) {
      lastError = error;
      logErr(appConfig, `❌ [FETCH_ERROR] ${requestId}: Attempt ${attempt + 1} failed - ${error.message}`);

      updateCircuitBreaker(cbKey, false, appConfig.circuitBreaker);

      if (attempt < retryConfig.maxRetries) {
        continue;
      }
    }
  }

  logErr(appConfig, `💥 [FETCH_EXHAUSTED] ${requestId}: All ${retryConfig.maxRetries + 1} attempts failed`);
  throw lastError || new Error('All retry attempts failed');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const appConfig = buildAppConfig(env);

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
      return handleHealthCheck(env, appConfig);
    }

    // 监控端点
    if (url.pathname === '/metrics') {
      return handleMetrics(appConfig);
    }

    // 熔断器状态端点
    if (url.pathname === '/circuit-breakers') {
      return handleCircuitBreakerStatus(appConfig);
    }

    // 处理 chat completions
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env, appConfig);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleChatCompletions(request: Request, env: Env, appConfig: AppConfig): Promise<Response> {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();

  // 增强的请求监控
  const requestMetrics = {
    requestId,
    startTime,
    clientIP: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown',
    userAgent: request.headers.get('User-Agent') || 'unknown',
    contentLength: request.headers.get('Content-Length') || '0',
  };

  logInfo(appConfig, `🚀 [REQUEST_START] ${requestId}: ${requestMetrics.clientIP} | ${requestMetrics.userAgent.substring(0, 50)}`);
  
  try {
    // 提取 API Key
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
      logErr(appConfig, `🔐 [AUTH_ERROR] ${requestId}: Missing Authorization header`);
      logError(requestId, 'Missing Authorization header', Date.now() - startTime);
      return jsonResponse({ error: 'Missing Authorization header' }, 401);
    }

    const apiKey = authHeader.replace('Bearer ', '');
    if (apiKey === authHeader) {
      logErr(appConfig, `🔐 [AUTH_ERROR] ${requestId}: Invalid Authorization header format`);
      logError(requestId, 'Invalid Authorization header format', Date.now() - startTime);
      return jsonResponse({ error: 'Invalid Authorization header format' }, 401);
    }

    // 解析请求并记录大小
    const requestText = await request.text();
    const requestSize = new TextEncoder().encode(requestText).length;
    logDebug(appConfig, `📊 [REQUEST_SIZE] ${requestId}: ${requestSize} bytes`);
    
    let openaiReq: OpenAIRequest;
    try {
      openaiReq = JSON.parse(requestText);
    } catch (parseError) {
      logErr(appConfig, `📝 [JSON_ERROR] ${requestId}: Invalid JSON format`);
      logError(requestId, 'Invalid JSON format', Date.now() - startTime);
      return jsonResponse({ error: 'Invalid JSON format' }, 400);
    }
    
    const validationError = validateOpenAIRequest(openaiReq);
    if (validationError) {
      logWarn(appConfig, `🧪 [REQUEST_VALIDATION] ${requestId}: ${validationError}`);
      return jsonResponse({ error: validationError }, 400);
    }

    // 增强的请求详情记录
    const requestInfo = {
      model: openaiReq.model,
      stream: openaiReq.stream || false,
      maxTokens: openaiReq.max_tokens || 'auto',
      messageCount: openaiReq.messages?.length || 0,
      temperature: openaiReq.temperature || 1.0,
      topP: openaiReq.top_p || 1.0,
    };

    logDebug(appConfig, `📋 [REQUEST_INFO] ${requestId}: ${JSON.stringify(requestInfo)}`);
    logRequestStart(requestId, request, sanitizeForLog(openaiReq), safeApiKeyPrefix(apiKey));

    // 解析配置
    const modelMapping = parseModelMapping(env.MODEL_MAPPING || '');
    const maxTokensMapping = parseMaxTokensMapping(env.MAX_TOKENS_MAPPING || '');
    const sessionTTLMinutes = parsePositiveInt(env.SESSION_TTL_MINUTES, 60);
    const proxyMode = (env.PROXY_MODE || 'anthropic').toLowerCase();

    logInfo(appConfig, `⚙️ [CONFIG] ${requestId}: Mode=${proxyMode}, Mappings=${modelMapping.size}/${maxTokensMapping.size}, Timeout=${appConfig.requestTimeoutMs}ms`);

    // 应用模型映射
    const originalModel = openaiReq.model;
    if (modelMapping.has(openaiReq.model)) {
      openaiReq.model = modelMapping.get(openaiReq.model)!;
      logInfo(appConfig, `🔄 [MODEL_MAPPING] ${requestId}: ${originalModel} -> ${openaiReq.model}`);
    }

    // 判断代理模式并记录性能指标
    const processingStartTime = Date.now();

    if (proxyMode === 'passthrough') {
      logInfo(appConfig, `🔄 [MODE] ${requestId}: Passthrough mode selected`);
      const result = await handlePassthroughMode(openaiReq, apiKey, env, requestId, startTime, appConfig);

      // 记录完整请求性能
      const totalTime = Date.now() - startTime;
      const processingTime = Date.now() - processingStartTime;
      logInfo(appConfig, `⏱️ [PERFORMANCE] ${requestId}: Total=${totalTime}ms, Processing=${processingTime}ms`);

      return result;
    }

    // Anthropic 模式：转换格式
    logInfo(appConfig, `🔄 [MODE] ${requestId}: Anthropic mode selected`);
    const anthropicReq = convertOpenAIToAnthropic(
      openaiReq,
      maxTokensMapping,
      apiKey,
      sessionTTLMinutes
    );
    
    // 发送到 Anthropic API
    const anthropicURL = getUpstreamBaseURL(env, 'https://api.anthropic.com');
    const upstreamHeaders = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey.substring(0, 12) + '...',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };
    
    logUpstreamRequest(requestId, `${anthropicURL}/v1/messages`, upstreamHeaders, sanitizeForLog(anthropicReq));

    const anthropicStartTime = Date.now();
    const anthropicResp = await fetchWithTimeout(
      `${anthropicURL}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: JSON.stringify(anthropicReq),
      },
      appConfig.requestTimeoutMs
    );

    const anthropicTime = Date.now() - anthropicStartTime;
    logInfo(appConfig, `⏱️ [ANTHROPIC_TIME] ${requestId}: ${anthropicTime}ms`);

    logUpstreamResponse(requestId, anthropicResp.status, anthropicResp.statusText, anthropicResp.headers);
    
    if (!anthropicResp.ok) {
      const errorText = await anthropicResp.text();
      logErr(appConfig, `❌ [ANTHROPIC_ERROR] ${requestId}: Status ${anthropicResp.status} - ${errorText.substring(0, 200)}`);
      logError(requestId, `Upstream error: ${errorText}`, Date.now() - startTime, {
        status: anthropicResp.status,
        anthropicTime,
      });

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
      logInfo(appConfig, `🌊 [STREAM_MODE] ${requestId}: Starting Anthropic stream processing`);
      logStreamStart(requestId);
      return handleStreamResponse(anthropicResp, openaiReq.model, requestId, startTime, appConfig);
    }

    // 非流式响应
    const anthropicData: AnthropicResponse = await anthropicResp.json();
    const openaiResp = convertAnthropicToOpenAI(anthropicData);
    
    const totalTime = Date.now() - startTime;
    const processingTime = Date.now() - processingStartTime;
    logInfo(appConfig, `⏱️ [PERFORMANCE] ${requestId}: Total=${totalTime}ms, Processing=${processingTime}ms, Anthropic=${anthropicTime}ms`);
    
    logRequestComplete(requestId, totalTime, openaiResp);

    return jsonResponse(openaiResp, 200);
  } catch (error: any) {
    const totalTime = Date.now() - startTime;
    logErr(appConfig, `💥 [FATAL_ERROR] ${requestId}: ${error.message} (${totalTime}ms)`);
    
    // 详细错误分类
    let errorType = 'unknown_error';
    let statusCode = 500;
    
    if (error.name === 'SyntaxError') {
      errorType = 'json_parse_error';
      statusCode = 400;
    } else if (error.name === 'TypeError' && error.message.includes('fetch')) {
      errorType = 'network_error';
      statusCode = 502;
    } else if (error.name === 'AbortError') {
      errorType = 'timeout_error';
      statusCode = 408;
    }
    
    logError(requestId, error, totalTime, { 
      errorType,
      stack: error.stack?.substring(0, 500)
    });
    
    return jsonResponse({ 
      error: {
        message: error.message || 'Internal Server Error',
        type: errorType,
        request_id: requestId
      }
    }, statusCode);
  }
}

async function handleStreamResponse(
  anthropicResp: Response,
  model: string,
  requestId: string,
  startTime: number,
  appConfig: AppConfig
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      console.log(`🌊 [STREAM_START] ${requestId}: Starting Anthropic stream processing`);
      
      const reader = anthropicResp.body!.getReader();
      const decoder = new TextDecoder();
      let messageID = '';
      let usage: any = null;
      let toolIndex = 0;
      let buffer = ''; // 添加缓冲区处理不完整的数据
      let eventCount = 0; // 事件计数器，类似基础项目

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        
        // 使用缓冲区处理不完整的数据行
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后一个可能不完整的行

        for (const line of lines) {
          eventCount++;
          // 记录每一行以便调试（类似基础项目的详细日志）
          console.log(`🔍 [STREAM_LINE] ${requestId}[${eventCount}]: ${line}`);
          
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]' || data === '') continue;

          try {
            const event = JSON.parse(data);
            const eventType = event.type;
            
            // 详细记录事件类型（类似基础项目）
            console.log(`📋 [EVENT_TYPE] ${requestId}: ${eventType}`);

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
            console.error('Failed to parse event:', e, 'Raw data:', data);
            // 继续处理，不要因为单个事件解析失败就中断整个流
          }
        }
      }

      // 处理缓冲区中剩余的数据
      if (buffer.trim()) {
        try {
          if (buffer.startsWith('data:')) {
            const data = buffer.slice(5).trim();
            if (data && data !== '[DONE]') {
              const event = JSON.parse(data);
              // 处理最后一个事件（如果需要的话）
            }
          }
        } catch (e) {
          console.error('Failed to parse final buffer:', e);
        }
      }

      await writer.write(encoder.encode('data: [DONE]\n\n'));
      console.log(`🏁 [STREAM_END] ${requestId}: Completed with ${eventCount} events`);
      logStreamComplete(requestId, Date.now() - startTime);
    } catch (error) {
      console.error('Stream error:', error);
      logError(requestId, error as Error, Date.now() - startTime);
      // 确保即使出错也发送 [DONE]
      try {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error('Failed to write final [DONE]:', e);
      }
    } finally {
      try {
        await writer.close();
      } catch (e) {
        console.error('Failed to close writer:', e);
      }
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

// 透传模式：直接转发 OpenAI 格式请求（优化版本 + 重试机制）
async function handlePassthroughMode(
  openaiReq: OpenAIRequest,
  apiKey: string,
  env: Env,
  requestId: string,
  startTime: number,
  appConfig: AppConfig
): Promise<Response> {
  const baseURL = getUpstreamBaseURL(env, 'https://api.openai.com');
  const targetURL = `${baseURL}/v1/chat/completions`;
  
  // 优化的请求信息记录
  logInfo(appConfig, `🔄 [PASSTHROUGH] ${requestId}: ${openaiReq.model} -> ${targetURL} (${openaiReq.stream ? 'stream' : 'sync'})`);
  
  // 构建请求头，保持原始格式
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  
  // 传递客户端的其他重要头部（如果在环境变量中配置）
  // const clientHeaders = ['User-Agent', 'X-Request-ID', 'Accept-Encoding'];
  // clientHeaders.forEach(header => {
  //   const value = request.headers.get(header);
  //   if (value) {
  //     requestHeaders[header] = value;
  //   }
  // });
  
  const maskedHeaders = {
    ...requestHeaders,
    'Authorization': `Bearer ${apiKey.substring(0, 12)}...`,
  };
  
  logUpstreamRequest(requestId, targetURL, maskedHeaders, sanitizeForLog(openaiReq));
  
  try {
    // 使用带重试和熔断器的请求
    const requestOptions: RequestInit = {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(openaiReq),
    };
    
    // 根据请求类型调整重试配置
    const retryConfig: RetryConfig = {
      maxRetries: openaiReq.stream ? Math.min(1, appConfig.retry.maxRetries) : appConfig.retry.maxRetries,
      baseDelay: appConfig.retry.baseDelay,
      maxDelay: openaiReq.stream ? Math.min(3000, appConfig.retry.maxDelay) : appConfig.retry.maxDelay,
      retryableStatuses: appConfig.retry.retryableStatuses,
    };

    const targetResp = await fetchWithRetry(targetURL, requestOptions, requestId, appConfig, retryConfig);
    
    logInfo(appConfig, `📨 [PASSTHROUGH_RESPONSE] ${requestId}: ${targetResp.status} ${targetResp.statusText}`);
    logUpstreamResponse(requestId, targetResp.status, targetResp.statusText, targetResp.headers);

    // 处理错误响应，保持原始状态码和头部
    if (!targetResp.ok) {
      const errorText = await targetResp.text();
      logErr(appConfig, `❌ [PASSTHROUGH_ERROR] ${requestId}: Status ${targetResp.status}`);
      logError(requestId, `Passthrough error: ${errorText}`, Date.now() - startTime, { 
        status: targetResp.status,
        statusText: targetResp.statusText 
      });
      
      // 保持原始响应头部
      const responseHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
      };
      
      // 传递重要的响应头部
      const importantHeaders = ['Content-Type', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];
      importantHeaders.forEach(header => {
        const value = targetResp.headers.get(header);
        if (value) {
          responseHeaders[header] = value;
        }
      });
      
      return new Response(errorText, {
        status: targetResp.status,
        statusText: targetResp.statusText,
        headers: responseHeaders,
      });
    }

    // 流式响应处理
    if (openaiReq.stream) {
      logInfo(appConfig, `🌊 [PASSTHROUGH_STREAM] ${requestId}: Starting optimized stream processing`);
      logStreamStart(requestId);

      return handlePassthroughStream(targetResp, requestId, startTime, appConfig);
    }

    // 非流式响应处理
    const responseData = await targetResp.json();
    logInfo(appConfig, `✅ [PASSTHROUGH_COMPLETE] ${requestId}: Response received (${JSON.stringify(responseData).length} bytes)`);
    logRequestComplete(requestId, Date.now() - startTime, sanitizeForLog(responseData));
    
    // 保持原始响应头部
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };
    
    // 传递重要的响应头部
    const importantHeaders = ['X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-ID'];
    importantHeaders.forEach(header => {
      const value = targetResp.headers.get(header);
      if (value) {
        responseHeaders[header] = value;
      }
    });
    
    return new Response(JSON.stringify(responseData), {
      status: targetResp.status,
      statusText: targetResp.statusText,
      headers: responseHeaders,
    });
    
  } catch (error: any) {
    // 处理重试机制和熔断器的错误
    if (error.message === 'Circuit breaker is open') {
      logErr(appConfig, `🚫 [CIRCUIT_BREAKER] ${requestId}: Service temporarily unavailable`);
      logError(requestId, 'Circuit breaker open', Date.now() - startTime, { circuitBreaker: true });
      
      return jsonResponse({ 
        error: { 
          message: 'Service temporarily unavailable', 
          type: 'service_unavailable',
          code: 'circuit_breaker_open'
        } 
      }, 503);
    }
    
    if (error.name === 'AbortError') {
      logErr(appConfig, `⏰ [PASSTHROUGH_TIMEOUT] ${requestId}: Request timeout`);
      logError(requestId, 'Request timeout', Date.now() - startTime, { timeout: true });
      
      return jsonResponse({ 
        error: { 
          message: 'Request timeout', 
          type: 'timeout_error',
          code: 'request_timeout'
        } 
      }, 408);
    }
    
    logErr(appConfig, `💥 [PASSTHROUGH_NETWORK_ERROR] ${requestId}: ${error?.message || 'unknown'}`);
    logError(requestId, `Network error: ${error.message}`, Date.now() - startTime, { 
      networkError: true,
      errorType: error.name 
    });
    
    return jsonResponse({ 
      error: { 
        message: 'Network error occurred', 
        type: 'network_error',
        code: 'network_failure'
      } 
    }, 502);
  }
}

// 优化的透传流式处理函数
async function handlePassthroughStream(
  targetResp: Response,
  requestId: string,
  startTime: number,
  appConfig: AppConfig
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // 保持原始响应头部
  const responseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  };
  
  // 传递重要的流式响应头部
  const streamHeaders = ['X-Request-ID', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'];
  streamHeaders.forEach(header => {
    const value = targetResp.headers.get(header);
    if (value) {
      responseHeaders[header] = value;
    }
  });
  
  (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    
    try {
      reader = targetResp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventCount = 0;
      let bytesProcessed = 0;
      
      logInfo(appConfig, `🌊 [PASSTHROUGH_STREAM_START] ${requestId}: Starting optimized stream processing`);
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`📊 [STREAM_STATS] ${requestId}: Processed ${bytesProcessed} bytes, ${eventCount} events`);
          break;
        }

        bytesProcessed += value.length;
        
        // 优化的缓冲区处理
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        
        // 高效的行分割处理
        let lineStart = 0;
        let lineEnd = buffer.indexOf('\n', lineStart);
        
        while (lineEnd !== -1) {
          const line = buffer.slice(lineStart, lineEnd);
          eventCount++;
          
          // 只在调试模式下记录详细日志
          if (eventCount % 10 === 0 || eventCount <= 5) {
            console.log(`🔍 [PASSTHROUGH_LINE] ${requestId}[${eventCount}]: ${line.substring(0, 100)}${line.length > 100 ? '...' : ''}`);
          }
          
          // 直接转发（保持原始格式，包括换行符）
          await writer.write(encoder.encode(line + '\n'));
          
          lineStart = lineEnd + 1;
          lineEnd = buffer.indexOf('\n', lineStart);
        }
        
        // 保留未完成的行
        buffer = buffer.slice(lineStart);
        
        // 防止缓冲区过大
        if (buffer.length > 8192) {
          console.warn(`⚠️ [BUFFER_WARNING] ${requestId}: Large buffer detected (${buffer.length} chars)`);
          // 如果缓冲区太大，强制输出并清空
          if (buffer.trim()) {
            await writer.write(encoder.encode(buffer));
            eventCount++;
          }
          buffer = '';
        }
      }
      
      // 处理缓冲区中剩余的数据
      if (buffer.trim()) {
        eventCount++;
        console.log(`🔍 [PASSTHROUGH_FINAL] ${requestId}[${eventCount}]: ${buffer.substring(0, 100)}${buffer.length > 100 ? '...' : ''}`);
        await writer.write(encoder.encode(buffer));
      }
      
      console.log(`🏁 [PASSTHROUGH_STREAM_END] ${requestId}: Completed ${eventCount} events, ${bytesProcessed} bytes in ${Date.now() - startTime}ms`);
      logStreamComplete(requestId, Date.now() - startTime);
      
    } catch (error: any) {
      console.error(`❌ [PASSTHROUGH_STREAM_ERROR] ${requestId}:`, error);
      logError(requestId, error, Date.now() - startTime);
      
      // 尝试发送错误信息给客户端
      try {
        const errorEvent = {
          error: {
            message: 'Stream processing error',
            type: 'stream_error',
            code: 'stream_failure'
          }
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (writeError) {
        console.error(`❌ [ERROR_WRITE_FAILED] ${requestId}:`, writeError);
      }
    } finally {
      // 确保资源清理
      try {
        if (reader) {
          await reader.cancel();
        }
      } catch (e) {
        console.error(`❌ [READER_CANCEL_ERROR] ${requestId}:`, e);
      }
      
      try {
        await writer.close();
      } catch (e) {
        console.error(`❌ [WRITER_CLOSE_ERROR] ${requestId}:`, e);
      }
    }
  })();

  return new Response(readable, {
    status: targetResp.status,
    statusText: targetResp.statusText,
    headers: responseHeaders,
  });
}

// 健康检查端点
async function handleHealthCheck(env: Env, appConfig: AppConfig): Promise<Response> {
  const proxyMode = (env.PROXY_MODE || 'anthropic').toLowerCase();
  const baseURL = getUpstreamBaseURL(
    env,
    proxyMode === 'passthrough' ? 'https://api.openai.com' : 'https://api.anthropic.com'
  );
  
  // 检查上游服务健康状态
  let upstreamStatus = 'unknown';
  let upstreamLatency = 0;
  
  try {
    const startTime = Date.now();
    const response = await fetchWithTimeout(baseURL, {
      method: 'HEAD',
    }, Math.min(5000, appConfig.requestTimeoutMs));
    upstreamLatency = Date.now() - startTime;
    upstreamStatus = response.ok ? 'healthy' : 'unhealthy';
  } catch (error) {
    upstreamStatus = 'unreachable';
  }
  
  // 检查熔断器状态
  const circuitBreakerStats = Array.from(circuitBreakers.entries()).map(([key, state]) => ({
    service: key,
    state: state.state,
    failures: state.failures,
    lastFailure: state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : null,
  }));
  
  const healthData = {
    status: 'ok',
    service: 'OpenAI Compatible Proxy (Cloudflare Workers)',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    mode: proxyMode,
    upstream: {
      url: baseURL,
      status: upstreamStatus,
      latency_ms: upstreamLatency,
    },
    circuit_breakers: circuitBreakerStats,
    memory: {
      circuit_breakers_count: circuitBreakers.size,
    },
  };
  
  const statusCode = upstreamStatus === 'healthy' ? 200 : 503;
  
  return new Response(JSON.stringify(healthData, null, 2), {
    status: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 监控指标端点
async function handleMetrics(appConfig: AppConfig): Promise<Response> {
  const metrics = {
    timestamp: new Date().toISOString(),
    circuit_breakers: {
      total: circuitBreakers.size,
      states: Array.from(circuitBreakers.values()).reduce((acc, state) => {
        acc[state.state] = (acc[state.state] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
    memory_usage: {
      circuit_breakers_entries: circuitBreakers.size,
    },
  };
  
  return new Response(JSON.stringify(metrics, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 熔断器状态端点
async function handleCircuitBreakerStatus(appConfig: AppConfig): Promise<Response> {
  const now = Date.now();
  const status = Array.from(circuitBreakers.entries()).map(([key, state]) => ({
    service: key.replace('cb_', ''),
    state: state.state,
    failures: state.failures,
    last_failure: state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : null,
    time_since_failure_ms: state.lastFailureTime ? now - state.lastFailureTime : null,
    can_make_request: canMakeRequest(key, appConfig.circuitBreaker),
  }));
  
  return new Response(JSON.stringify({ circuit_breakers: status }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
