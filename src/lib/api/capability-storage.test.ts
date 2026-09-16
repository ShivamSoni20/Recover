import { describe, expect, it, vi } from "vitest";
import { transferSessionCapabilityToCase } from "./capability-storage";

describe("capability storage transfer", () => {
  it("copies the session capability to the linked case", () => {
    const storage = {
      getItem: vi.fn().mockReturnValue("cap-secret"),
      setItem: vi.fn(),
    };
    expect(transferSessionCapabilityToCase(storage, "session-1", "case-1")).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith("recover:capability:session:session-1");
    expect(storage.setItem).toHaveBeenCalledWith("recover:capability:case:case-1", "cap-secret");
  });

  it("does not create a case capability when the session token is absent", () => {
    const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() };
    expect(transferSessionCapabilityToCase(storage, "session-1", "case-1")).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
