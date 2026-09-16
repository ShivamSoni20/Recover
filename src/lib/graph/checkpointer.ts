import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { getPgPool } from "../db/pg-pool";

let checkpointerInstance: BaseCheckpointSaver | null = null;
const memorySaverInstance = new MemorySaver();

function volatileCheckpointerAllowed(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    (process.env.NODE_ENV !== "production" &&
      process.env.RECOVER_ALLOW_MEMORY_CHECKPOINTER === "true")
  );
}

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
    if (volatileCheckpointerAllowed()) {
      console.warn("[Checkpointer] Explicit volatile fallback enabled:", err);
      return memorySaverInstance;
    }
    throw new Error(
      "[Checkpointer] Durable PostgreSQL checkpointing is unavailable; refusing to run workflow.",
      { cause: err },
    );
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
