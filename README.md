# @rishabjs03/agent-context

> Context window management for AI agents — auto-compact, token tracking, and smart summarization.

Extracted from a production AI coding agent. Prevents context overflow with proactive summarization, token tracking, and multi-layered compaction strategies.

## Features

- ⚡ **Auto-compact** — proactive context summarization before overflow
- 🔬 **Microcompact** — deduplicate redundant tool results
- 📊 **Token warning states** — warning, error, blocking thresholds
- 🔌 **Circuit breaker** — stop retrying after consecutive failures
- 🧠 **LLM-powered summarization** — customizable compaction prompts
- 🎯 **Model presets** — pre-configured for Claude, GPT-4, etc.

## Install

```bash
npm install @rishabjs03/agent-context
```

## Quick Start

```typescript
import { ContextManager, createContextManager } from '@rishabjs03/agent-context';

const ctx = createContextManager('claude-sonnet-4-20250514', async (conversation, systemPrompt) => {
  const response = await llm.messages.create({
    model: 'claude-3-5-haiku-20241022',
    system: systemPrompt,
    messages: [{ role: 'user', content: conversation }],
    max_tokens: 4096,
  });
  return response.content[0].text;
});

// In your agent loop:
const result = await ctx.autoCompactIfNeeded(messages);
if (result.wasCompacted) {
  messages = result.messages;
  console.log(`Freed ${result.tokensFreed} tokens`);
}
```

## Token Warning States

Monitor context utilization with graduated thresholds:

```typescript
const state = ctx.getWarningState(messages);

if (state.isAtBlockingLimit) {
  console.error('Context full! Cannot proceed.');
} else if (state.isAboveAutoCompactThreshold) {
  console.warn('Auto-compacting...');
  const result = await ctx.compact(messages);
} else if (state.isAboveWarningThreshold) {
  console.warn(`${state.percentLeft}% context remaining`);
}
```

## Microcompact: Deduplicate Tool Results

Remove redundant tool outputs from conversation history:

```typescript
const cleaned = ctx.microCompact(messages);
// Older duplicate tool results are replaced with summaries
```

## Custom Configuration

```typescript
const ctx = new ContextManager({
  contextWindowTokens: 200_000,
  maxOutputTokensReserve: 20_000,  // Reserve for model output
  autoCompactBuffer: 13_000,        // Trigger compact at window - buffer
  warningBuffer: 20_000,            // Show warning at this threshold
  blockingBuffer: 3_000,            // Hard stop at this threshold
  maxConsecutiveFailures: 3,         // Circuit breaker limit
  autoCompactEnabled: true,
  llmSummarize: async (messages, systemPrompt) => {
    // Your summarization LLM call
  },
  countTokens: (text) => {
    // Optional: use a real tokenizer
    return Math.ceil(text.length / 4);
  },
});
```

## How Auto-Compact Works

```
┌─────────────────────────────────────────────────────┐
│                  Context Window                     │
│                                                     │
│  [System Prompt] [Messages...] [Reserved Output]    │
│                                                     │
│  ├── Warning ──┤ ├── Auto-compact ──┤ ├── Block ──┤ │
│  │   Buffer    │ │     Buffer       │ │  Buffer   │ │
│  └─────────────┘ └──────────────────┘ └───────────┘ │
└─────────────────────────────────────────────────────┘

When messages exceed the auto-compact threshold:
1. Split messages into [history] + [recent tail]
2. Summarize [history] via LLM
3. Replace with [summary] + [recent tail]
4. Resume with compacted context
```

## License

MIT
