import type { AskQuestionRequest } from "@helios/ports";
import { describe, expect, it } from "vitest";
import { askApproval, type ApprovalOverlayHost } from "./approvalOverlay";

class FakeApprovalHost implements ApprovalOverlayHost {
  request?: AskQuestionRequest;
  private resolve?: (answers: string[]) => void;

  show(request: AskQuestionRequest, resolve: (answers: string[]) => void): void {
    this.request = request;
    this.resolve = resolve;
  }

  answer(...answers: string[]): void {
    this.resolve?.(answers);
  }
}

describe("askApproval", () => {
  it("resolves a selected label", async () => {
    const host = new FakeApprovalHost();
    const response = askApproval(host, {
      question: "Proceed?",
      options: [{ label: "Allow" }, { label: "Deny" }],
    });

    host.answer("Deny");

    await expect(response).resolves.toEqual({ answers: ["Deny"] });
  });

  it("resolves no answers when the overlay is cancelled", async () => {
    const host = new FakeApprovalHost();
    const response = askApproval(host, { question: "Proceed?" });

    host.answer();

    await expect(response).resolves.toEqual({ answers: [] });
  });

  it("resolves freely typed text, not just preset labels", async () => {
    const host = new FakeApprovalHost();
    const response = askApproval(host, { question: "Which drink?" });

    host.answer("乌龙茶");

    await expect(response).resolves.toEqual({ answers: ["乌龙茶"] });
  });

  it("hands the whole request to the overlay so descriptions and header survive", async () => {
    // The old contract flattened options to string labels here, silently dropping `description`
    // and `header` before the overlay could render them.
    const host = new FakeApprovalHost();
    const request: AskQuestionRequest = {
      question: "Pick a base",
      header: "Branch",
      options: [{ label: "main", description: "latest" }],
    };
    askApproval(host, request);

    expect(host.request).toBe(request);
  });

  it("ignores a second resolve from another overlay callback", async () => {
    const host = new FakeApprovalHost();
    const response = askApproval(host, { question: "Proceed?" });

    host.answer("first");
    host.answer("second");

    await expect(response).resolves.toEqual({ answers: ["first"] });
  });
});
