import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getPgPool } from "../db/pg-pool";

let checkpointerInstance: PostgresSaver | null = null;

export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!checkpointerInstance) {
    const pool = getPgPool();
    checkpointerInstance = new PostgresSaver(pool);
    // Initialize tables if needed
    try {
      await checkpointerInstance.setup();
    } catch (err) {
      console.warn("[Checkpointer] Setup tables notice:", err);
    }
  }
  return checkpointerInstance;
}
