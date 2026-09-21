export interface EmailRequest {
  from: string;
  to: string[];
  subject: string;
  text: string;
}
export type SendEmail = (request: EmailRequest, key: string) => Promise<void>;
export class DeliveryError extends Error {
  constructor(
    public code:
      "email_unavailable" | "email_rejected" | "email_retry" | "email_budget",
  ) {
    super(code);
  }
}
export function resendAdapter(
  apiKey: string,
  transport: typeof fetch = fetch,
): SendEmail {
  return async (request, key) => {
    let response: Response;
    try {
      response = await transport("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new DeliveryError("email_retry");
    }
    if (!response.ok)
      throw new DeliveryError(
        response.status === 429 ||
          response.status >= 500 ||
          response.status === 409
          ? "email_retry"
          : "email_rejected",
      );
    // Provider response bodies are never included in logs or job errors.
  };
}
