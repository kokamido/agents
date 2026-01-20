/* eslint-disable @typescript-eslint/ban-ts-comment */
import { AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { getEnvironmentVariable } from '@langchain/core/utils/env';
import { GoogleGenerativeAI as GenerativeAI } from '@google/generative-ai';
import type {
  GenerateContentRequest,
  SafetySetting,
} from '@google/generative-ai';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage, UsageMetadata } from '@langchain/core/messages';
import type { GeminiGenerationConfig } from '@langchain/google-common';
import type { GeminiApiUsageMetadata, InputTokenDetails } from './types';
import type { GoogleClientOptions } from '@/types';
import {
  convertResponseContentToChatGenerationChunk,
  convertBaseMessagesToContent,
  mapGenerateContentResultToChatResult,
} from './utils/common';

// Import OpenAI client for chat completions API
import { OpenAI as OpenAIClient } from 'openai';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import {
  convertBaseMessagesToOpenAIParams,
  convertOpenAIResponseToChatResult,
  convertOpenAIStreamChunkToChatGenerationChunk,
} from './utils/openai_compat';

/**
 * Custom Google Generative AI client that uses OpenAI-compatible Chat Completion API
 * instead of the native Google generateContent/generateContentStream endpoints.
 * 
 * This allows using Google's Gemini models through their OpenAI-compatible endpoint:
 * https://generativelanguage.googleapis.com/v1beta/openai/
 */
export class CustomChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
  private openaiClient: OpenAIClient;
  private useOpenAICompatibleAPI: boolean = true;

  /**
   * Override to add gemini-3 model support for multimodal and function calling thought signatures
   */
  get _isMultimodalModel(): boolean {
    return (
      this.model.startsWith('gemini-1.5') ||
      this.model.startsWith('gemini-2') ||
      (this.model.startsWith('gemma-3-') &&
        !this.model.startsWith('gemma-3-1b')) ||
      this.model.startsWith('gemini-3')
    );
  }

  constructor(fields: GoogleClientOptions) {
    super(fields);

    this.model = fields.model.replace(/^models\//, '');

    this.maxOutputTokens = fields.maxOutputTokens ?? this.maxOutputTokens;

    if (this.maxOutputTokens != null && this.maxOutputTokens < 0) {
      throw new Error('`maxOutputTokens` must be a positive integer');
    }

    this.temperature = fields.temperature ?? this.temperature;
    if (
      this.temperature != null &&
      (this.temperature < 0 || this.temperature > 2)
    ) {
      throw new Error('`temperature` must be in the range of [0.0,2.0]');
    }

    this.topP = fields.topP ?? this.topP;
    if (this.topP != null && this.topP < 0) {
      throw new Error('`topP` must be a positive integer');
    }

    if (this.topP != null && this.topP > 1) {
      throw new Error('`topP` must be below 1.');
    }

    this.topK = fields.topK ?? this.topK;
    if (this.topK != null && this.topK < 0) {
      throw new Error('`topK` must be a positive integer');
    }

    this.stopSequences = fields.stopSequences ?? this.stopSequences;

    this.apiKey = fields.apiKey ?? getEnvironmentVariable('GOOGLE_API_KEY');
    if (this.apiKey == null || this.apiKey === '') {
      throw new Error(
        'Please set an API key for Google GenerativeAI ' +
          'in the environment variable GOOGLE_API_KEY ' +
          'or in the `apiKey` field of the ' +
          'ChatGoogleGenerativeAI constructor'
      );
    }

    this.safetySettings = fields.safetySettings ?? this.safetySettings;
    if (this.safetySettings && this.safetySettings.length > 0) {
      const safetySettingsSet = new Set(
        this.safetySettings.map((s) => s.category)
      );
      if (safetySettingsSet.size !== this.safetySettings.length) {
        throw new Error(
          'The categories in `safetySettings` array must be unique'
        );
      }
    }

    this.streaming = fields.streaming ?? this.streaming;
    this.json = fields.json;

    // Initialize OpenAI-compatible client
    const baseURL = fields.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai';
    
    this.openaiClient = new OpenAIClient({
      apiKey: this.apiKey,
      baseURL: baseURL,
      defaultHeaders: fields.customHeaders,
    });

    this.streamUsage = fields.streamUsage ?? this.streamUsage;
  }

  static lc_name(): 'LibreChatGoogleGenerativeAI' {
    return 'LibreChatGoogleGenerativeAI';
  }

  /**
   * Helper function to convert OpenAI usage metadata to LangChain format
   */
  private _convertToUsageMetadata(
    usage: ChatCompletion.Usage | undefined
  ): UsageMetadata | undefined {
    if (!usage) {
      return undefined;
    }

    const output: UsageMetadata = {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    };

    // Handle cached tokens if present
    if ('prompt_tokens_details' in usage && usage.prompt_tokens_details) {
      const details = usage.prompt_tokens_details as any;
      if (details.cached_tokens) {
        output.input_token_details ??= {};
        output.input_token_details.cache_read = details.cached_tokens;
      }
    }

    return output;
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<import('@langchain/core/outputs').ChatResult> {
    const openaiMessages = convertBaseMessagesToOpenAIParams(
      messages,
      this._isMultimodalModel,
      this.model
    );

    const requestParams: OpenAIClient.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: openaiMessages,
      temperature: this.temperature,
      top_p: this.topP,
      max_tokens: this.maxOutputTokens,
      stop: this.stopSequences,
      stream: false,
    };

    // Add response format for JSON mode
    if (this.json) {
      requestParams.response_format = { type: 'json_object' };
    }

    const response = await this.caller.callWithOptions(
      { signal: options.signal },
      async () => this.openaiClient.chat.completions.create(requestParams)
    ) as ChatCompletion;

    const usageMetadata = this._convertToUsageMetadata(response.usage);
    const generationResult = convertOpenAIResponseToChatResult(response, {
      usageMetadata,
    });

    await runManager?.handleLLMNewToken(
      generationResult.generations[0].text || '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    );
    
    return generationResult;
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const openaiMessages = convertBaseMessagesToOpenAIParams(
      messages,
      this._isMultimodalModel,
      this.model
    );

    const requestParams: OpenAIClient.Chat.ChatCompletionCreateParams = {
      model: this.model,
      messages: openaiMessages,
      temperature: this.temperature,
      top_p: this.topP,
      max_tokens: this.maxOutputTokens,
      stop: this.stopSequences,
      stream: true,
      stream_options: this.streamUsage !== false && options.streamUsage !== false 
        ? { include_usage: true } 
        : undefined,
    };

    // Add response format for JSON mode
    if (this.json) {
      requestParams.response_format = { type: 'json_object' };
    }

    const stream = await this.caller.callWithOptions(
      { signal: options.signal },
      async () => this.openaiClient.chat.completions.create(requestParams)
    );

    let index = 0;
    let lastUsageMetadata: UsageMetadata | undefined;
    
    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      // Extract usage metadata from the final chunk
      if (chunk.usage) {
        lastUsageMetadata = this._convertToUsageMetadata(chunk.usage as any);
      }

      const generationChunk = convertOpenAIStreamChunkToChatGenerationChunk(chunk, {
        usageMetadata: undefined,
        index,
      });
      
      index += 1;
      
      if (!generationChunk) {
        continue;
      }

      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text || '',
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk }
      );
    }

    // Yield final chunk with usage metadata
    if (lastUsageMetadata) {
      const finalChunk = new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({
          content: '',
          usage_metadata: lastUsageMetadata,
        }),
      });
      yield finalChunk;
      await runManager?.handleLLMNewToken(
        finalChunk.text || '',
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk: finalChunk }
      );
    }
  }
}
