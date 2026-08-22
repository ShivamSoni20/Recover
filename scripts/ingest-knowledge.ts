import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { supabase } from "../src/lib/db/supabase";
import { OpenRouterEmbeddings } from "../src/lib/ai/openrouter-embeddings";

dotenv.config();

async function ingestKnowledge() {
  console.log("=== RAG Knowledge Ingestion ===");

  const knowledgeDir = path.join(process.cwd(), "knowledge");
  const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));

  if (files.length === 0) {
    console.error("No knowledge documents found in /knowledge.");
    process.exit(1);
  }

  const embeddings = new OpenRouterEmbeddings();

  for (const file of files) {
    const filePath = path.join(knowledgeDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const source = `knowledge/${file}`;
    const title = file.replace(".md", "").replace(/-/g, " ").toUpperCase();

    console.log(`\nProcessing: ${file}...`);

    // 1. Upsert document record
    const { data: doc, error: docError } = await supabase
      .from("knowledge_documents")
      .upsert({ source, title, version: "1.0.0" }, { onConflict: "source" })
      .select("id")
      .single();

    if (docError) {
      console.error(`Error saving document ${source}:`, docError.message);
      continue;
    }

    // 2. Chunk content by section headers
    const rawSections = content.split(/\n(?=## )/);
    const chunks = rawSections.map((sec, idx) => ({
      document_id: doc.id,
      chunk_index: idx,
      content: sec.trim(),
      metadata: { source, title, index: idx },
    }));

    console.log(`Generating embeddings for ${chunks.length} chunks...`);

    for (const chunk of chunks) {
      try {
        const vector = await embeddings.embedQuery(chunk.content);
        await supabase.from("knowledge_chunks").insert({
          document_id: chunk.document_id,
          chunk_index: chunk.chunk_index,
          content: chunk.content,
          metadata: chunk.metadata,
          embedding: vector,
        });
      } catch (err: unknown) {
        console.warn(`[Warning] Embedding failed for chunk ${chunk.chunk_index}:`, err);
      }
    }

    console.log(`Completed ${file}`);
  }

  console.log("\n=== Ingestion Complete ===");
}

ingestKnowledge().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
