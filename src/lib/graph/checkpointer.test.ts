import { beforeEach, describe, expect, it, vi } from "vitest";

const setup = vi.fn();
vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: class {
    setup = setup;
  },
}));
vi.mock("../db/pg-pool", () => ({ getPgPool: vi.fn(() => ({})) }));

describe("production checkpointer durability", () => {
  beforeEach(() => {
    vi.resetModules();
    setup.mockReset();
    delete process.env.RECOVER_ALLOW_MEMORY_CHECKPOINTER;
  });

  it("never falls back to MemorySaver in production", async () => {
    process.env.NODE_ENV = "production";
    setup.mockRejectedValueOnce(new Error("database unavailable"));
    const { getCheckpointer } = await import("./checkpointer");
    await expect(getCheckpointer()).rejects.toThrow(
      "Durable PostgreSQL checkpointing is unavailable",
    );
  }, 15_000);
});
