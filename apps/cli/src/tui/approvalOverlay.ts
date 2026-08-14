import type { AskQuestionRequest, AskQuestionResponse } from "@helios/ports";

export interface ApprovalOverlayHost {
  show(question: string, options: readonly string[], resolve: (answer: string | undefined) => void): void;
}

export function askApproval(
  host: ApprovalOverlayHost,
  request: AskQuestionRequest,
): Promise<AskQuestionResponse> {
  return new Promise((resolve) => {
    let settled = false;
    host.show(
      request.question,
      request.options?.map((option) => option.label) ?? [],
      (answer) => {
        if (settled) return;
        settled = true;
        resolve({ answers: answer === undefined ? [] : [answer] });
      },
    );
  });
}
