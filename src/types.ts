// 类型定义
export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: any;
  user?: string;
}

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContent[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface OpenAIContent {
  type: string;
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface OpenAITool {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters: any;
  };
}

export interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

// Anthropic 类型定义
export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: AnthropicSystemBlock[];
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  metadata?: {
    user_id: string;
  };
}

export interface AnthropicMessage {
  role: string;
  content: string | AnthropicContent[];
}

export interface AnthropicContent {
  type: string;
  text?: string;
  tool_use_id?: string;
  content?: any;
  id?: string;
  name?: string;
  input?: any;
  cache_control?: CacheControl;
  source?: ImageSource;
}

export interface AnthropicSystemBlock {
  type: string;
  text: string;
  cache_control?: CacheControl;
}

export interface CacheControl {
  type: string;
  ttl?: string;
}

export interface ImageSource {
  type: string;
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContent[];
  model: string;
  stop_reason: string;
  stop_sequence?: string;
  usage: AnthropicUsage;
}

export interface AnthropicUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details: {
      cached_tokens: number;
      audio_tokens: number;
    };
    completion_tokens_details: {
      reasoning_tokens: number;
      audio_tokens: number;
      accepted_prediction_tokens: number;
      rejected_prediction_tokens: number;
    };
  };
  service_tier?: string;
}

export interface Env {
  ANTHROPIC_BASE_URL?: string;
  MODEL_MAPPING?: string;
  MAX_TOKENS_MAPPING?: string;
  MAX_TOKENS?: string;
  SESSION_TTL_MINUTES?: string;
  PROXY_MODE?: string; // 'anthropic' | 'passthrough'
  LOG_LEVEL?: string; // 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  MAX_RETRIES?: string;
  RETRY_BASE_DELAY?: string;
  RETRY_MAX_DELAY?: string;
  RETRYABLE_STATUSES?: string; // 例如: "408,429,502,503,504"
  REQUEST_TIMEOUT_MS?: string;
  CIRCUIT_BREAKER_FAILURE_THRESHOLD?: string;
  CIRCUIT_BREAKER_TIMEOUT?: string;
}
