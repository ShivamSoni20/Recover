import { Embeddings, type EmbeddingsParams } from "@langchain/core/embeddings";
import dotenv from "dotenv";

dotenv.config();

export class OpenRouterEmbeddings extends Embeddings {
  modelName: string;
  apiKey: string;
  dimensions?: number;

  constructor(
    fields?: EmbeddingsParams & {
      modelName?: string;
      apiKey?: string;
      dimensions?: number;
    }
  ) {
    super(fields ?? {});
    this.apiKey = fields?.apiKey || process.env.OPENROUTER_API_KEY || "";
    this.modelName =
      fields?.modelName || process.env.OPENROUTER_EMBEDDING_MODEL || "openai/text-embedding-3-small";
    this.dimensions = fields?.dimensions;
  }

  async embedDocuments(documents: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error("[OpenRouter Embeddings] OPENROUTER_API_KEY is not configured.");
    }
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelName,
        input: documents,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter Embeddings API failed [${response.status}]: ${err}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async embedQuery(document: string): Promise<number[]> {
    const embeddings = await this.embedDocuments([document]);
    return embeddings[0];
  }
}
