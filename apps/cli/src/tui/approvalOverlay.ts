import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";

/**
 * The overlay receives the whole request rather than a pre-flattened list of labels: option
 * descriptions and `header` are part of the question and used to be discarded here, and an open
 * question (no `options` at all) needs a free-text path that a `string[]` cannot express.
 *
 * `resolve` takes the answers array directly so it lines up with `AskQuestionResponse.answers`:
 * one entry for a choice or a typed answer, empty for cancel. That also leaves room for
 * `multiSelect` later without changing this contract.
 */
export interface ApprovalOverlayHost {
  show(request: AskQuestionRequest, resolve: (answers: string[]) => void): void;
}

export function askApproval(
  host: ApprovalOverlayHost,
  request: AskQuestionRequest,
): Promise<AskQuestionResponse> {
  return new Promise((resolve) => {
    let settled = false;
    host.show(request, (answers) => {
      // The overlay wires several components' callbacks; guard against a double resolve.
      if (settled) return;
      settled = true;
      resolve({ answers });
    });
  });
}
