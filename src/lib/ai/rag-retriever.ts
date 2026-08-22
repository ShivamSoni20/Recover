import { supabase } from "../db/supabase";
import { OpenRouterEmbeddings } from "./openrouter-embeddings";

export interface RetrievedChunk {
  chunkId: string;
  source: string;
  title: string;
  content: string;
  score: number;
}

export async function retrieveRecoveryKnowledge(query: string, limit = 3): Promise<RetrievedChunk[]> {
  try {
    const embeddings = new OpenRouterEmbeddings();
    const queryEmbedding = await embeddings.embedQuery(query);

    if (!queryEmbedding || queryEmbedding.length === 0) {
      console.warn("[RAG Retriever] Empty embedding generated for query.");
      return [];
    }

    // Call Supabase RPC match_knowledge_chunks returning joined document source
    const { data, error } = await supabase.rpc("match_knowledge_chunks", {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: limit,
    });

    if (error || !data || (data as unknown[]).length === 0) {
      console.log("[RAG Retriever] No semantic match or RPC unpopulated:", error?.message);
      return [];
    }

    return (data as Array<{
      id: string;
      document_id: string;
      source: string;
      title: string;
      content: string;
      similarity: number;
    }>).map((row) => ({
      chunkId: row.id,
      source: row.source,
      title: row.title,
      content: row.content,
      score: row.similarity,
    }));
  } catch (err) {
    console.warn("[RAG Retriever] Semantic retrieval failed safely:", err);
    return [];
  }
}
