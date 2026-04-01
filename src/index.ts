/**
 * @anthropic-agents/agent-context
 *
 * Context window management for AI agents.
 * Prevents context overflow with auto-compaction, token tracking,
 * and smart conversation summarization.
 *
 * Features:
 * - Auto-compact: proactive context summarization before overflow
 * - Microcompact: remove redundant tool results from history
 * - Token warning states: warning, error, blocking thresholds
 * - Circuit breaker: stop retrying after consecutive failures
 * - LLM-powered summarization with customizable prompts
 *
 * Extracted from a production AI coding agent.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  /** Unique ID for deduplication */
  uuid?: string;
  /** Token usage from API response (if assistant message) */
  usage?: TokenUsage;
  /** Tool use/result metadata */
  toolUseId?: string;
  toolName?: string;
  isToolResult?: boolean;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface CompactionResult {
  /** The compacted messages (summary + preserved tail) */
  messages: Message[];
  /** Token count before compaction */
  preCompactTokens: number;
  /** Token count after compaction */
  postCompactTokens: number;
  /** Tokens freed by compaction */
  tokensFreed: number;
  /** Whether compaction occurred */
  wasCompacted: boolean;
}

export interface TokenWarningState {
  /** Percentage of context remaining */
  percentLeft: number;
  /** Above the warning threshold (show warning to user) */
  isAboveWarningThreshold: boolean;
  /** Above the error threshold (urgent) */
  isAboveErrorThreshold: boolean;
  /** Above the auto-compact threshold (trigger compaction) */
  isAboveAutoCompactThreshold: boolean;
  /** At the hard blocking limit (cannot proceed) */
  isAtBlockingLimit: boolean;
}

export interface ContextManagerConfig {
  /** Maximum context window size in tokens */
  contextWindowTokens: number;
  /** Reserve this many tokens for output (default: 20000) */
  maxOutputTokensReserve?: number;
  /** Buffer tokens before auto-compact triggers (default: 13000) */
  autoCompactBuffer?: number;
  /** Buffer tokens for warning threshold (default: 20000) */
  warningBuffer?: number;
  /** Buffer tokens for blocking limit (default: 3000) */
  blockingBuffer?: number;
  /** Max consecutive auto-compact failures before circuit breaker (default: 3) */
  maxConsecutiveFailures?: number;
  /** LLM function for summarization */
  llmSummarize: (messages: string, systemPrompt: string) => Promise<string>;
  /** Custom token counter (default: rough estimation) */
  countTokens?: (text: string) => number;
  /** Enable auto-compact (default: true) */
  autoCompactEnabled?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_OUTPUT_RESERVE = 20_000;
const DEFAULT_AUTOCOMPACT_BUFFER = 13_000;
const DEFAULT_WARNING_BUFFER = 20_000;
const DEFAULT_BLOCKING_BUFFER = 3_000;
const DEFAULT_MAX_FAILURES = 3;

// ─── Token Estimation ────────────────────────────────────────────────

/**
 * Rough token count estimation (~4 chars per token for English text).
 * Use a real tokenizer for production accuracy.
 */
export function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens in a message array.
 */
export function estimateMessageTokens(
  messages: Message[],
  countTokens: (text: string) => number = roughTokenCount
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.text) total += countTokens(block.text);
        if (block.content) total += countTokens(block.content);
        if (block.input)
          total += countTokens(JSON.stringify(block.input));
      }
    }
    // Use API-reported usage if available (more accurate)
    if (msg.usage) {
      total = Math.max(total, msg.usage.inputTokens);
    }
  }
  return total;
}

// ─── Compaction Prompts ──────────────────────────────────────────────

const DEFAULT_COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to create a concise summary of the conversation that preserves all important context, decisions, and action items.

Rules:
- Preserve all file paths, function names, and technical details
- Keep track of what was done and what remains to do
- Note any user preferences or corrections
- Include error messages and their resolutions
- Keep git commit hashes, branch names, and PR URLs
- Summarize repetitive tool calls (e.g., "Read 5 files in src/")
- Do NOT include thinking blocks or system messages
- Output raw text, not markdown (unless the original used markdown)

Format your summary as a structured recap with sections for:
1. Goal/Task
2. Key decisions and findings
3. Changes made (files modified, commands run)
4. Current state and next steps`;

// ─── Context Manager ─────────────────────────────────────────────────

export class ContextManager {
  private config: Required<ContextManagerConfig>;
  private consecutiveFailures = 0;
  private compactionCount = 0;

  constructor(config: ContextManagerConfig) {
    this.config = {
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokensReserve:
        config.maxOutputTokensReserve ?? DEFAULT_OUTPUT_RESERVE,
      autoCompactBuffer:
        config.autoCompactBuffer ?? DEFAULT_AUTOCOMPACT_BUFFER,
      warningBuffer: config.warningBuffer ?? DEFAULT_WARNING_BUFFER,
      blockingBuffer: config.blockingBuffer ?? DEFAULT_BLOCKING_BUFFER,
      maxConsecutiveFailures:
        config.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES,
      llmSummarize: config.llmSummarize,
      countTokens: config.countTokens ?? roughTokenCount,
      autoCompactEnabled: config.autoCompactEnabled ?? true,
    };
  }

  /**
   * Get effective context window (after reserving output tokens).
   */
  get effectiveContextWindow(): number {
    return (
      this.config.contextWindowTokens - this.config.maxOutputTokensReserve
    );
  }

  /**
   * Get the auto-compact threshold (tokens).
   */
  get autoCompactThreshold(): number {
    return this.effectiveContextWindow - this.config.autoCompactBuffer;
  }

  /**
   * Calculate token warning state for the current message array.
   */
  getWarningState(messages: Message[]): TokenWarningState {
    const tokenCount = estimateMessageTokens(
      messages,
      this.config.countTokens
    );
    return this.calculateWarningState(tokenCount);
  }

  /**
   * Calculate token warning state from a token count.
   */
  calculateWarningState(tokenCount: number): TokenWarningState {
    const effective = this.effectiveContextWindow;
    const threshold = this.config.autoCompactEnabled
      ? this.autoCompactThreshold
      : effective;

    const percentLeft = Math.max(
      0,
      Math.round(((threshold - tokenCount) / threshold) * 100)
    );

    const warningThreshold = threshold - this.config.warningBuffer;
    const blockingLimit = effective - this.config.blockingBuffer;

    return {
      percentLeft,
      isAboveWarningThreshold: tokenCount >= warningThreshold,
      isAboveErrorThreshold: tokenCount >= warningThreshold, // same threshold for simplicity
      isAboveAutoCompactThreshold:
        this.config.autoCompactEnabled &&
        tokenCount >= this.autoCompactThreshold,
      isAtBlockingLimit: tokenCount >= blockingLimit,
    };
  }

  /**
   * Check if auto-compaction should be triggered.
   */
  shouldAutoCompact(messages: Message[]): boolean {
    if (!this.config.autoCompactEnabled) return false;
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      return false; // Circuit breaker
    }

    const tokenCount = estimateMessageTokens(
      messages,
      this.config.countTokens
    );
    return tokenCount >= this.autoCompactThreshold;
  }

  /**
   * Auto-compact messages if the context is above threshold.
   * Returns the original messages unchanged if not needed.
   */
  async autoCompactIfNeeded(
    messages: Message[]
  ): Promise<CompactionResult> {
    if (!this.shouldAutoCompact(messages)) {
      return {
        messages,
        preCompactTokens: estimateMessageTokens(
          messages,
          this.config.countTokens
        ),
        postCompactTokens: estimateMessageTokens(
          messages,
          this.config.countTokens
        ),
        tokensFreed: 0,
        wasCompacted: false,
      };
    }

    return this.compact(messages);
  }

  /**
   * Force compact the conversation messages.
   */
  async compact(
    messages: Message[],
    customPrompt?: string
  ): Promise<CompactionResult> {
    const preCompactTokens = estimateMessageTokens(
      messages,
      this.config.countTokens
    );

    try {
      // Preserve recent messages (tail) for context continuity
      const tailSize = Math.min(Math.ceil(messages.length * 0.2), 10);
      const toSummarize = messages.slice(0, messages.length - tailSize);
      const preserved = messages.slice(messages.length - tailSize);

      if (toSummarize.length === 0) {
        return {
          messages,
          preCompactTokens,
          postCompactTokens: preCompactTokens,
          tokensFreed: 0,
          wasCompacted: false,
        };
      }

      // Build conversation text for summarization
      const conversationText = toSummarize
        .map((m) => {
          const content =
            typeof m.content === "string"
              ? m.content
              : m.content
                  .map((b) => b.text || b.content || "")
                  .join("\n");
          return `[${m.role}]: ${content}`;
        })
        .join("\n\n");

      const summary = await this.config.llmSummarize(
        conversationText,
        customPrompt ?? DEFAULT_COMPACT_SYSTEM_PROMPT
      );

      // Build compacted message array
      const summaryMessage: Message = {
        role: "user",
        content: `<context_summary>\nThis is a summary of the conversation so far:\n\n${summary}\n</context_summary>`,
        metadata: {
          isCompactSummary: true,
          compactionNumber: ++this.compactionCount,
          originalMessageCount: toSummarize.length,
        },
      };

      const compacted = [summaryMessage, ...preserved];
      const postCompactTokens = estimateMessageTokens(
        compacted,
        this.config.countTokens
      );

      // Reset failure counter on success
      this.consecutiveFailures = 0;

      return {
        messages: compacted,
        preCompactTokens,
        postCompactTokens,
        tokensFreed: preCompactTokens - postCompactTokens,
        wasCompacted: true,
      };
    } catch (error) {
      this.consecutiveFailures++;

      if (
        this.consecutiveFailures >= this.config.maxConsecutiveFailures
      ) {
        console.warn(
          `[agent-context] Circuit breaker tripped after ${this.consecutiveFailures} consecutive compact failures`
        );
      }

      return {
        messages,
        preCompactTokens,
        postCompactTokens: preCompactTokens,
        tokensFreed: 0,
        wasCompacted: false,
      };
    }
  }

  /**
   * Microcompact: Remove redundant tool results from conversation history.
   * Keeps the most recent result for each tool_use_id, summarizes older ones.
   */
  microCompact(messages: Message[]): Message[] {
    const seenToolResults = new Map<string, number>();
    const result: Message[] = [];

    // Walk backwards to find latest result for each tool
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.isToolResult && msg.toolUseId) {
        if (!seenToolResults.has(msg.toolUseId)) {
          seenToolResults.set(msg.toolUseId, i);
        }
      }
    }

    // Walk forward, keeping all non-tool-result messages and only the latest tool results
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.isToolResult && msg.toolUseId) {
        const latestIdx = seenToolResults.get(msg.toolUseId);
        if (latestIdx !== undefined && latestIdx !== i) {
          // This is an older duplicate — replace with a summary
          result.push({
            ...msg,
            content: `[Previous ${msg.toolName ?? "tool"} result replaced by updated result]`,
          });
          continue;
        }
      }
      result.push(msg);
    }

    return result;
  }

  /**
   * Reset the context manager's internal state.
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.compactionCount = 0;
  }
}

// ─── Convenience Functions ───────────────────────────────────────────

/**
 * Create a context manager pre-configured for common models.
 */
export function createContextManager(
  model: string,
  llmSummarize: (messages: string, systemPrompt: string) => Promise<string>,
  options?: Partial<ContextManagerConfig>
): ContextManager {
  const contextWindows: Record<string, number> = {
    "claude-sonnet-4-20250514": 200_000,
    "claude-3-5-sonnet-20241022": 200_000,
    "claude-3-5-haiku-20241022": 200_000,
    "claude-3-opus-20240229": 200_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4-turbo": 128_000,
    "gpt-4": 8_192,
  };

  const contextWindowTokens = contextWindows[model] ?? 128_000;

  return new ContextManager({
    contextWindowTokens,
    llmSummarize,
    ...options,
  });
}
