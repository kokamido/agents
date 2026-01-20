/**
 * Utility functions for converting between LangChain messages and OpenAI Chat Completion format
 * This enables using Google's Gemini models through their OpenAI-compatible endpoint
 */

import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import type { BaseMessage, UsageMetadata } from '@langchain/core/messages';
import type { ChatGeneration, ChatResult } from '@langchain/core/outputs';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import { ToolCallChunk } from '@langchain/core/messages/tool';
import { v4 as uuidv4 } from 'uuid';

type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

/**
 * Converts LangChain BaseMessage array to OpenAI chat completion message format
 */
export function convertBaseMessagesToOpenAIParams(
  messages: BaseMessage[],
  isMultimodalModel: boolean,
  model?: string
): OpenAIMessage[] {
  return messages.map((message) => {
    const role = getOpenAIRole(message);
    const content = convertMessageContent(message, isMultimodalModel);
    
    const openaiMessage: OpenAIMessage = {
      role,
      content,
    };

    // Add tool calls for AI messages
    if (message._getType() === 'ai' && 'tool_calls' in message && message.tool_calls) {
      const aiMessage = message as AIMessage;
      if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
        openaiMessage.tool_calls = aiMessage.tool_calls.map((tc) => ({
          id: tc.id || uuidv4(),
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));
      }
    }

    // Add tool_call_id for tool messages
    if (message._getType() === 'tool' && 'tool_call_id' in message) {
      openaiMessage.tool_call_id = (message as any).tool_call_id;
    }

    // Add name if present
    if (message.name) {
      openaiMessage.name = message.name;
    }

    return openaiMessage;
  });
}

/**
 * Get OpenAI role from LangChain message type
 */
function getOpenAIRole(message: BaseMessage): 'system' | 'user' | 'assistant' | 'tool' {
  const type = message._getType();
  switch (type) {
    case 'system':
      return 'system';
    case 'human':
      return 'user';
    case 'ai':
      return 'assistant';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return 'user';
  }
}

/**
 * Convert message content to OpenAI format
 */
function convertMessageContent(
  message: BaseMessage,
  isMultimodalModel: boolean
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content.map((part) => {
      if (typeof part === 'string') {
        return { type: 'text', text: part };
      }
      
      if ('type' in part) {
        if (part.type === 'text' && 'text' in part) {
          return { type: 'text', text: part.text as string };
        }
        if (part.type === 'image_url' && 'image_url' in part) {
          const imageUrl = typeof part.image_url === 'string' 
            ? part.image_url 
            : (part.image_url as any).url;
          return { type: 'image_url', image_url: { url: imageUrl } };
        }
      }
      
      return { type: 'text', text: JSON.stringify(part) };
    });
  }

  return '';
}

/**
 * Convert OpenAI ChatCompletion response to LangChain ChatResult
 */
export function convertOpenAIResponseToChatResult(
  response: ChatCompletion,
  extra?: {
    usageMetadata: UsageMetadata | undefined;
  }
): ChatResult {
  const choice = response.choices[0];
  if (!choice || !choice.message) {
    return {
      generations: [],
      llmOutput: {},
    };
  }

  const message = choice.message;
  let content: string | Array<any> = message.content || '';
  
  // Handle tool calls
  const tool_calls = message.tool_calls?.map((tc) => ({
    type: 'tool_call' as const,
    id: tc.id,
    name: tc.function.name,
    args: JSON.parse(tc.function.arguments),
  })) || [];

  const generation: ChatGeneration = {
    text: typeof content === 'string' ? content : '',
    message: new AIMessage({
      content,
      tool_calls,
      additional_kwargs: {
        finish_reason: choice.finish_reason,
      },
      usage_metadata: extra?.usageMetadata,
    }),
    generationInfo: {
      finish_reason: choice.finish_reason,
    },
  };

  return {
    generations: [generation],
    llmOutput: {
      tokenUsage: {
        promptTokens: extra?.usageMetadata?.input_tokens,
        completionTokens: extra?.usageMetadata?.output_tokens,
        totalTokens: extra?.usageMetadata?.total_tokens,
      },
    },
  };
}

/**
 * Convert OpenAI streaming chunk to LangChain ChatGenerationChunk
 */
export function convertOpenAIStreamChunkToChatGenerationChunk(
  chunk: ChatCompletionChunk,
  extra: {
    usageMetadata?: UsageMetadata | undefined;
    index: number;
  }
): ChatGenerationChunk | null {
  const choice = chunk.choices[0];
  if (!choice || !choice.delta) {
    return null;
  }

  const delta = choice.delta;
  const content = delta.content || '';
  
  // Handle tool call chunks
  const toolCallChunks: ToolCallChunk[] = [];
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      toolCallChunks.push({
        type: 'tool_call_chunk' as const,
        id: tc.id,
        name: tc.function?.name,
        args: tc.function?.arguments || '',
        index: tc.index,
      });
    }
  }

  const additional_kwargs: Record<string, any> = {};
  if (choice.finish_reason) {
    additional_kwargs.finish_reason = choice.finish_reason;
  }

  return new ChatGenerationChunk({
    text: content,
    message: new AIMessageChunk({
      content,
      tool_call_chunks: toolCallChunks,
      additional_kwargs,
      usage_metadata: extra.usageMetadata,
    }),
    generationInfo: {
      finish_reason: choice.finish_reason,
    },
  });
}