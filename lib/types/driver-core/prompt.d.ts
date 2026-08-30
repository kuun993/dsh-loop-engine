/**
 * Serialization of the durable session history into the prompt text of one
 * hosted-engine query. Both the Claude Code and Codex drivers build their
 * per-step input from the durable session log: the transcript is the log's
 * exact projection, so a later replay of the same log derives the identical
 * prompt (Model-visible ⟺ logged bridge).
 *
 * @module dsh-loop-engine/driver-core/prompt
 */
import type { Message } from '@deepseek-ai/dsh-llm';
/** Model-facing stand-in for an image block that the hosted engines cannot consume as bytes. */
export declare const OMITTED_IMAGE_TEXT = "[image omitted: the driver does not transcribe images; read the file when a path is available]";
/**
 * Serialize a derived conversation history into the prompt text of one hosted
 * query. The last message is the live user request that triggered the step;
 * every earlier message is durable replay context. The output is a pure
 * function of the log prefix.
 * @param messages - derived history, oldest first, as returned by
 *   `Session.deriveMessages()` at step time.
 * @returns the prompt text to pass to the engine.
 */
export declare function serializeHistory(messages: readonly Message[]): string;
//# sourceMappingURL=prompt.d.ts.map