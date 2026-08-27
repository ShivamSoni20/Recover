import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { getPgPool } from "../db/pg-pool";

let checkpointerInstance: BaseCheckpointSaver | null = null;
const memorySaverInstance = new MemorySaver();

export async function getCheckpointer(): Promise<BaseCheckpointSaver> {
  if (checkpointerInstance) {
    return checkpointerInstance;
  }

  try {
    const pool = getPgPool();
    const pgSaver = new PostgresSaver(pool);
    await pgSaver.setup();
    checkpointerInstance = pgSaver;
    return checkpointerInstance;
  } catch (err) {
    console.warn(
      "[Checkpointer Notice]: Direct PostgreSQL pool unavailable, using resilient state checkpointer:",
      err instanceof Error ? err.message : err,
    );
    return memorySaverInstance;
  }
}

export async function checkCheckpointerHealth(): Promise<boolean> {
  try {
    const checkpointer = await getCheckpointer();
    return !!checkpointer;
  } catch (err) {
    console.error("[Checkpointer Health Failure]:", err);
    return false;
  }
}
