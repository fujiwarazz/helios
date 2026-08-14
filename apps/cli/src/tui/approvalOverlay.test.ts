import { describe, expect, it } from "vitest";
import { askApproval, type ApprovalOverlayHost } from "./approvalOverlay";

class FakeApprovalHost implements ApprovalOverlayHost {
  private resolve?: (answer: string | undefined) => void;

  show(_question: string, _options: readonly string[], resolve: (answer: string | undefined) => void): void {
    this.resolve = resolve;
  }

  choose(answer: string): void {
    this.resolve?.(answer);
  }

  cancel(): void {
    this.resolve?.(undefined);
  }
}

describe("askApproval", () => {
  it("resolves a selected label", async () => {
    const host = new FakeApprovalHost();
    const response = askApproval(host, {
      question: "Proceed?",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });

    host.choose("Deny");

    await expect(response).resolves.toEqual({ answers: ["Deny"] });
  });

  it("resolves no answers when the overlay is cancelled", async () => {
    const host = new FakeApprovalHost();
    const response = askApproval(host, { question: "Proceed?" });

    host.cancel();

    await expect(response).resolves.toEqual({ answers: [] });
  });
});
