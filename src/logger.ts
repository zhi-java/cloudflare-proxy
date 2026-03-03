// 日志工具模块 - 用于 Cloudflare Observability

export interface LogContext {
  requestId: string;
  timestamp: string;
  duration?: number;
  [key: string]: any;
}

export function logRequest(context: LogContext, level: 'INFO' | 'ERROR' | 'WARN', message: string, data?: any) {
  const logEntry = {
    level,
    message,
    ...context,
    ...(data && { data }),
  };
  
  const emoji = level === 'ERROR' ? '❌' : level === 'WARN' ? '⚠️' : '✅';
  console.log(`${emoji} [${level}]`, JSON.stringify(logEntry, null, 2));
}

export function logRequestStart(requestId: string, request: Request, body: any, apiKeyPrefix: string) {
  console.log('📥 [REQUEST_START]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    apiKeyPrefix,
  }, null, 2));
}

export function logUpstreamRequest(requestId: string, url: string, headers: Record<string, string>, body: any) {
  console.log('📤 [UPSTREAM_REQUEST]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    url,
    headers,
    body,
  }, null, 2));
}

export function logUpstreamResponse(requestId: string, status: number, statusText: string, headers: Headers, body?: any) {
  console.log('📨 [UPSTREAM_RESPONSE]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    status,
    statusText,
    headers: Object.fromEntries(headers.entries()),
    ...(body && { body }),
  }, null, 2));
}

export function logRequestComplete(requestId: string, duration: number, response: any) {
  console.log('✅ [REQUEST_COMPLETE]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    duration,
    response,
  }, null, 2));
}

export function logError(requestId: string, error: Error | string, duration: number, context?: any) {
  console.error('❌ [ERROR]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    duration,
    error: typeof error === 'string' ? error : {
      message: error.message,
      stack: error.stack,
    },
    ...(context && { context }),
  }, null, 2));
}

export function logStreamStart(requestId: string) {
  console.log('🌊 [STREAM_START]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
  }));
}

export function logStreamComplete(requestId: string, duration: number) {
  console.log('🌊 [STREAM_COMPLETE]', JSON.stringify({
    requestId,
    timestamp: new Date().toISOString(),
    duration,
  }));
}
