import { vi } from "vitest";
import type { MemoryReviewerService } from "../memory-reviewer-service.js";

type MemoryReviewer = Pick<MemoryReviewerService, "review">;

/** Builds a typed reviewer spy for memory-maintenance service tests. */
export function createMemoryReviewer(implementation: MemoryReviewer["review"]) {
  return {
    review: vi.fn<MemoryReviewer["review"]>(implementation),
  };
}
