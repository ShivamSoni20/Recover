import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";

dotenv.config();

export function getRecoverModel(options: { temperature?: number } = {}): ChatOpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("[OpenRouter] OPENROUTER_API_KEY is not configured.");
  }

  const modelName = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
  const appTitle = process.env.OPENROUTER_APP_TITLE || "Recover";
  const appUrl = process.env.APP_BASE_URL || "http://localhost:3000";

  return new ChatOpenAI({
    modelName,
    temperature: options.temperature ?? 0,
    openAIApiKey: apiKey,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": appUrl,
        "X-Title": appTitle,
      },
    },
  });
}
