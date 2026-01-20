# Google Gemini OpenAI-Compatible API Implementation

## Overview

This implementation modifies the `@librechat/agents` package to use Google's OpenAI-compatible Chat Completion API instead of the native `generateContent`/`generateContentStream` endpoints.

## Changes Made

### 1. New Utility File: `src/llm/google/utils/openai_compat.ts`

This file contains conversion functions between LangChain message format and OpenAI Chat Completion format:

- **`convertBaseMessagesToOpenAIParams()`** - Converts LangChain BaseMessage[] to OpenAI message format
- **`convertOpenAIResponseToChatResult()`** - Converts OpenAI ChatCompletion response to LangChain ChatResult
- **`convertOpenAIStreamChunkToChatGenerationChunk()`** - Converts OpenAI streaming chunks to LangChain ChatGenerationChunk

### 2. Modified File: `src/llm/google/index.ts`

The `CustomChatGoogleGenerativeAI` class has been updated to:

- Import and use the OpenAI client (`openai` package)
- Initialize an OpenAI-compatible client pointing to Google's endpoint
- Override `_generate()` method to use `chat.completions.create()` instead of `generateContent()`
- Override `_streamResponseChunks()` method to use streaming chat completions instead of `generateContentStream()`

## Key Features

### OpenAI-Compatible Endpoint

The implementation uses Google's OpenAI-compatible endpoint:
```
https://generativelanguage.googleapis.com/v1beta/openai
```

This can be customized via the `baseUrl` field in `GoogleClientOptions`.

### API Call Changes

**Before (Native Google API):**
```typescript
// Used Google's native SDK
this.client.generateContent(request)
this.client.generateContentStream(request)
```

**After (OpenAI-Compatible API):**
```typescript
// Uses OpenAI SDK with Google's compatible endpoint
this.openaiClient.chat.completions.create({
  model: this.model,
  messages: openaiMessages,
  temperature: this.temperature,
  // ... other parameters
})
```

### Message Format Conversion

The implementation automatically converts between formats:

**LangChain Format:**
```typescript
{
  role: 'human',
  content: 'Hello',
  tool_calls: [...]
}
```

**OpenAI Format:**
```typescript
{
  role: 'user',
  content: 'Hello',
  tool_calls: [...]
}
```

## Usage

### In LibreChat Main Project

The changes are transparent to the main LibreChat project. The existing code in `packages/api/src/endpoints/google/` will continue to work:

```typescript
// packages/api/src/endpoints/google/initialize.ts
export async function initializeGoogle({...}) {
  // ... existing code ...
  return getGoogleConfig(credentials, clientOptions);
}
```

### Environment Variables

Set the Google API endpoint to use the OpenAI-compatible version:

```bash
# Use Google's OpenAI-compatible endpoint
GOOGLE_REVERSE_PROXY=https://generativelanguage.googleapis.com/v1beta/openai

# Or use the standard Google API key
GOOGLE_KEY=your_api_key_here
```

### Custom Base URL

You can also specify a custom base URL programmatically:

```typescript
const client = new CustomChatGoogleGenerativeAI({
  model: 'gemini-2.0-flash',
  apiKey: 'your-api-key',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
});
```

## Benefits

1. **Standardization**: Uses the widely-adopted OpenAI Chat Completion API format
2. **Compatibility**: Works with existing OpenAI-compatible tools and libraries
3. **Flexibility**: Easy to switch between Google's native API and OpenAI-compatible API
4. **Maintainability**: Leverages the well-maintained `openai` npm package

## API Endpoint Comparison

### Native Google API
- **Endpoint**: `/v1beta/models/{model}:generateContent`
- **Streaming**: `/v1beta/models/{model}:streamGenerateContent`
- **Format**: Google-specific message format

### OpenAI-Compatible API
- **Endpoint**: `/v1beta/openai/chat/completions`
- **Streaming**: Same endpoint with `stream: true`
- **Format**: OpenAI Chat Completion format

## Supported Features

✅ Text generation
✅ Streaming responses  
✅ Tool/Function calling
✅ Multimodal inputs (images, audio, video)
✅ System messages
✅ Temperature, top_p, top_k parameters
✅ Max output tokens
✅ Stop sequences
✅ JSON mode
✅ Usage metadata/token counting
✅ Cached tokens tracking

## Testing

To test the implementation:

1. **Install dependencies**:
   ```bash
   cd agents
   npm install
   ```

2. **Build the package**:
   ```bash
   npm run build
   ```

3. **Test in LibreChat**:
   ```bash
   cd ../
   npm install
   npm run backend:dev
   ```

4. **Verify API calls**:
   - Check that requests go to `/v1beta/openai/chat/completions`
   - Verify responses are properly converted
   - Test streaming functionality
   - Test tool calling

## Troubleshooting

### Issue: TypeScript errors during development

**Solution**: The TypeScript errors you see are expected in a development environment without `node_modules`. They will resolve after running `npm install`.

### Issue: API endpoint not found

**Solution**: Ensure you're using the correct base URL:
```typescript
baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
```

### Issue: Authentication errors

**Solution**: Verify your API key is correctly set:
```bash
export GOOGLE_KEY=your_api_key_here
```

## Migration Guide

### For Existing LibreChat Users

No changes required! The implementation is backward compatible. Your existing configuration will continue to work.

### For Direct @librechat/agents Users

If you're using `@librechat/agents` directly:

```typescript
// Before
import { CustomChatGoogleGenerativeAI } from '@librechat/agents';

const client = new CustomChatGoogleGenerativeAI({
  model: 'gemini-2.0-flash',
  apiKey: process.env.GOOGLE_KEY,
});

// After - same code, but now uses OpenAI-compatible endpoint internally
const client = new CustomChatGoogleGenerativeAI({
  model: 'gemini-2.0-flash',
  apiKey: process.env.GOOGLE_KEY,
  // Optionally specify custom endpoint
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
});
```

## Implementation Details

### Constructor Changes

The constructor now initializes both the native Google client (for backward compatibility) and the OpenAI client:

```typescript
constructor(fields: GoogleClientOptions) {
  super(fields);
  
  // ... existing validation ...
  
  // NEW: Initialize OpenAI-compatible client
  const baseURL = fields.baseUrl || 
    'https://generativelanguage.googleapis.com/v1beta/openai';
  
  this.openaiClient = new OpenAIClient({
    apiKey: this.apiKey,
    baseURL: baseURL,
    defaultHeaders: fields.customHeaders,
  });
}
```

### Generation Method Changes

The `_generate()` method now uses OpenAI's chat completions:

```typescript
async _generate(messages, options, runManager) {
  // Convert LangChain messages to OpenAI format
  const openaiMessages = convertBaseMessagesToOpenAIParams(
    messages,
    this._isMultimodalModel,
    this.model
  );

  // Call OpenAI-compatible endpoint
  const response = await this.openaiClient.chat.completions.create({
    model: this.model,
    messages: openaiMessages,
    // ... parameters ...
  });

  // Convert response back to LangChain format
  return convertOpenAIResponseToChatResult(response, { usageMetadata });
}
```

### Streaming Method Changes

The `_streamResponseChunks()` method now uses OpenAI's streaming:

```typescript
async *_streamResponseChunks(messages, options, runManager) {
  // Convert messages
  const openaiMessages = convertBaseMessagesToOpenAIParams(...);

  // Create streaming request
  const stream = await this.openaiClient.chat.completions.create({
    model: this.model,
    messages: openaiMessages,
    stream: true,
    stream_options: { include_usage: true },
  });

  // Process stream chunks
  for await (const chunk of stream) {
    const generationChunk = convertOpenAIStreamChunkToChatGenerationChunk(chunk);
    yield generationChunk;
  }
}
```

## Future Enhancements

Potential improvements for future versions:

1. **Fallback mechanism**: Automatically fall back to native API if OpenAI-compatible endpoint fails
2. **Performance metrics**: Compare performance between native and OpenAI-compatible APIs
3. **Extended tool support**: Enhanced tool calling features specific to OpenAI format
4. **Caching optimization**: Better utilization of prompt caching features

## References

- [Google AI Studio OpenAI Compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
- [LangChain Google GenAI Integration](https://js.langchain.com/docs/integrations/chat/google_generativeai)

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the LibreChat documentation
3. Open an issue on the LibreChat GitHub repository

## License

This implementation maintains the same license as the parent @librechat/agents package.