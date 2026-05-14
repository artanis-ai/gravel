/**
 * Renderer registry. Every `SourceKind` maps to a dedicated
 * renderer; the only thing routed to `UnknownRenderer` is the
 * literal `unknown` kind (trace names `detectSource` doesn't
 * recognise).
 *
 * Unknown delegates to `HumanValue` and never JSON-dumps — that
 * way new provider shapes still produce a usable review surface
 * before a dedicated renderer lands.
 */
import type { SourceKind } from '../../../lib/source'
import type { Renderer } from '../types'
import { AnthropicMessagesRenderer } from './AnthropicMessages'
import { LangchainChainRenderer } from './LangchainChain'
import { LangchainChatModelRenderer } from './LangchainChatModel'
import { LangchainLLMRenderer } from './LangchainLLM'
import { LangchainRetrieverRenderer } from './LangchainRetriever'
import { LangchainToolRenderer } from './LangchainTool'
import { OpenAIChatRenderer } from './OpenAIChat'
import { OpenAIEmbeddingsRenderer } from './OpenAIEmbeddings'
import { OpenAIResponsesRenderer } from './OpenAIResponses'
import { UnknownRenderer } from './Unknown'
import { VercelAIObjectRenderer } from './VercelAIObject'
import { VercelAITextRenderer } from './VercelAIText'

export const RENDERERS: Record<SourceKind, Renderer> = {
  'openai-chat': OpenAIChatRenderer,
  'openai-responses': OpenAIResponsesRenderer,
  'openai-embeddings': OpenAIEmbeddingsRenderer,
  'anthropic-messages': AnthropicMessagesRenderer,
  'vercel-ai-text': VercelAITextRenderer,
  'vercel-ai-object': VercelAIObjectRenderer,
  'langchain-llm': LangchainLLMRenderer,
  'langchain-chat-model': LangchainChatModelRenderer,
  'langchain-chain': LangchainChainRenderer,
  'langchain-tool': LangchainToolRenderer,
  'langchain-retriever': LangchainRetrieverRenderer,
  unknown: UnknownRenderer,
}
