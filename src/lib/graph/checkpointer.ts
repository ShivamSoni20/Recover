import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getPgPool } from "../db/pg-pool";

let checkpointerInstance: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointerInstance) {
    const pool = getPgPool();
    checkpointerInstance = new PostgresSaver(pool);
    // Initialize tables in fail-closed mode
    await checkpointerInstance.setup();
  }
  return checkpointerInstance;
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
