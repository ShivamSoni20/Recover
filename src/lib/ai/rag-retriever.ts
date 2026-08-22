import { supabase } from "../db/supabase";
import { OpenRouterEmbeddings } from "./openrouter-embeddings";

export interface RetrievedChunk {
  chunkId: string;
  source: string;
  content: string;
  score: number;
}

export async function retrieveRecoveryKnowledge(query: string, limit = 3): Promise<RetrievedChunk[]> {
  try {
    const embeddings = new OpenRouterEmbeddings();
    const queryEmbedding = await embeddings.embedQuery(query);

    // Call Supabase RPC match_knowledge_chunks or fallback query
    const { data, error } = await supabase.rpc("match_knowledge_chunks", {
      query_embedding: queryEmbedding,
      match_threshold: 0.5,
      match_count: limit,
    });

    if (error || !data) {
      // Fallback: read directly from knowledge_chunks table
      const { data: chunks } = await supabase
        .from("knowledge_chunks")
        .select("id, content, metadata")
        .limit(limit);

      if (chunks && chunks.length > 0) {
        return chunks.map((c, i) => ({
          chunkId: c.id,
          source: (c.metadata as { source?: string })?.source || "knowledge/runbook",
          content: c.content,
          score: 0.8 - i * 0.1,
        }));
      }
      return [];
    }

    return (data as Array<{ id: string; source: string; content: string; similarity: number }>).map((row) => ({
      chunkId: row.id,
      source: row.source || "knowledge/merchant-policy",
      content: row.content,
      score: row.similarity,
    }));
  } catch (err) {
    console.warn("[RAG Retriever] Embedding search failed or uninitialized:", err);
    return [];
  }
}
