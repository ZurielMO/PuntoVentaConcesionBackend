import axios, { isAxiosError } from "axios";

const BREVO_SMTP_URL = "https://api.brevo.com/v3/smtp/email";

const getBrevoConfig = () => ({
  apiKey: process.env.BREVO_API_KEY?.trim(),
  senderEmail: process.env.BREVO_SENDER_EMAIL?.trim() || "no-reply@clubleon.com",
  senderName: process.env.BREVO_SENDER_NAME?.trim() || "Club León",
});

export const isLocalDevRuntime = (): boolean =>
  process.env.IS_LOCAL === "true" ||
  (process.env.NODE_ENV !== "production" &&
    !process.env.K_SERVICE &&
    !process.env.FUNCTION_NAME);

export const logBrevoSendError = (context: string, error: unknown): void => {
  if (isAxiosError(error)) {
    const data = error.response?.data as { message?: string; code?: string } | undefined;
    console.error(`[Brevo] ${context} failed`, {
      status: error.response?.status,
      code: data?.code,
      message: data?.message,
    });
    return;
  }

  console.error(
    `[Brevo] ${context} failed`,
    error instanceof Error ? error.message : "unknown error",
  );
};

export type SendBrevoEmailInput = {
  to: string;
  name?: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
};

export async function sendBrevoEmail(input: SendBrevoEmailInput): Promise<boolean> {
  const { apiKey, senderEmail, senderName } = getBrevoConfig();
  const to = input.to.trim().toLowerCase();
  if (!to) {
    console.error("[Brevo] Destinatario vacío");
    return false;
  }

  if (!apiKey) {
    if (isLocalDevRuntime()) {
      console.warn(`[Brevo] API key faltante; no se envía "${input.subject}" a ${to}`);
    } else {
      console.error("[Brevo] API key faltante");
    }
    return false;
  }

  try {
    await axios.post(
      BREVO_SMTP_URL,
      {
        sender: { email: senderEmail, name: senderName },
        to: [{ email: to, name: input.name || "Cliente" }],
        subject: input.subject,
        htmlContent: input.htmlContent,
        ...(input.textContent ? { textContent: input.textContent } : {}),
      },
      {
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
      },
    );
    console.info("[Brevo] Email enviado", { to, subject: input.subject });
    return true;
  } catch (error) {
    logBrevoSendError("sendBrevoEmail", error);
    return false;
  }
}
