import { sendBrevoEmail } from "../../lib/brevo/client";
import type { VipOrder, VipOrderItemSnapshot } from "../../models/vip.model";

const CLUB_LEON_LOGO_URL =
  "https://storage.googleapis.com/app-oficial-leon.firebasestorage.app/galeria/e5a06d0a-9ca3-4864-b481-be2e7b0fa23a.png";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const money = (value: number): string => `$${Number(value || 0).toFixed(2)} MXN`;

const itemDetails = (item: VipOrderItemSnapshot): string => {
  const extras = [
    ...(item.selectedOptions || []).map((option) => option.name),
    ...(item.extras || []).map((extra) => extra.name),
  ].filter(Boolean);
  const note = item.notes?.trim();
  const parts: string[] = [];
  if (extras.length) parts.push(escapeHtml(extras.join(", ")));
  if (note) parts.push(`* ${escapeHtml(note)}`);
  return parts.length ? `<div class="muted">${parts.join(" · ")}</div>` : "";
};

const itemsHtml = (order: VipOrder): string =>
  (order.items || [])
    .map(
      (item) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #E9EFEB;vertical-align:top;">
            <strong>${item.quantity}x</strong> ${escapeHtml(item.name)}
            ${itemDetails(item)}
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #E9EFEB;text-align:right;white-space:nowrap;">
            ${money(item.lineTotal)}
          </td>
        </tr>`,
    )
    .join("");

const totalsHtml = (order: VipOrder): string => {
  const tipRow =
    Number(order.tip || 0) > 0
      ? `<tr><td>Propina</td><td style="text-align:right;">${money(order.tip)}</td></tr>`
      : "";
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:14px;color:#4A5568;">
      <tr><td>Subtotal</td><td style="text-align:right;">${money(order.subtotal)}</td></tr>
      <tr><td>Cargo por servicio</td><td style="text-align:right;">${money(order.serviceFee)}</td></tr>
      ${tipRow}
      <tr>
        <td style="padding-top:10px;font-weight:700;color:#007A53;">Total</td>
        <td style="padding-top:10px;text-align:right;font-weight:700;color:#007A53;">${money(order.total)}</td>
      </tr>
    </table>`;
};

const deliveryLine = (order: VipOrder): string => {
  const zona = order.delivery?.zona || "";
  const palco = order.delivery?.palco || "";
  const nivel = order.delivery?.nivel ? ` · ${order.delivery.nivel}` : "";
  return `Palco ${escapeHtml(palco)} · ${escapeHtml(zona)}${escapeHtml(nivel)}`;
};

const wrapHtml = (title: string, heading: string, body: string): string => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; line-height: 1.6; color: #2D3748; background-color: #f4f6f8; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
    .wrapper { background-color: #f4f6f8; width: 100%; padding: 40px 0; }
    .container { max-width: 550px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05); }
    .header { background: linear-gradient(135deg, #006341 0%, #007A53 100%); padding: 10px 20px; text-align: center; border-bottom: 4px solid #D4AF37; }
    .header img { margin-bottom: 10px; filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.2)); }
    .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
    .content { padding: 40px 35px; background-color: #ffffff; }
    .content h2 { color: #007A53; margin-top: 0; font-size: 22px; font-weight: 700; }
    .content p { font-size: 15px; color: #4A5568; margin-bottom: 18px; }
    .muted { font-size: 12px; color: #718096; }
    .note { font-size: 13px; color: #718096; background-color: #F7FAFC; padding: 12px 15px; border-left: 3px solid #D4AF37; border-radius: 0 4px 4px 0; margin-top: 24px; }
    .signature { margin-top: 24px; font-weight: 600; color: #007A53; }
    .footer { text-align: center; padding: 30px 20px; font-size: 12px; color: #A0AEC0; }
    .motto { font-weight: bold; color: #718096; text-transform: uppercase; letter-spacing: 1px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <img src="${CLUB_LEON_LOGO_URL}" alt="Club León Logo" width="60" />
        <h1>Servicio Palcos</h1>
      </div>
      <div class="content">
        <h2>${heading}</h2>
        ${body}
        <p class="signature">¡Gracias por ser parte de la familia esmeralda!</p>
      </div>
      <div class="footer">
        <p class="motto">Ser Fiera Es Un Orgullo</p>
        <p>© ${new Date().getFullYear()} Club León. Todos los derechos reservados.</p>
      </div>
    </div>
  </div>
</body>
</html>
`;

const orderSummaryHtml = (order: VipOrder): string => `
  <p><strong>Pedido:</strong> ${escapeHtml(order.orderNumber)}<br/>
  <strong>Entrega:</strong> ${deliveryLine(order)}</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#2D3748;">
    ${itemsHtml(order)}
  </table>
  ${totalsHtml(order)}
`;

const notifyEmailFailure = (context: string, error: unknown): void => {
  console.error(`[Brevo] ${context} threw`, error instanceof Error ? error.message : error);
};

export async function sendVipOrderPaidEmail(order: VipOrder): Promise<boolean> {
  const email = order.customer?.email?.trim();
  if (!email) {
    console.error("[Brevo] Orden de palcos sin email de cliente", { orderId: order.id });
    return false;
  }
  const name = order.customer.name || "Cliente";
  const subject = `Pedido confirmado ${order.orderNumber} - Servicio Palcos Club León`;
  try {
    return await sendBrevoEmail({
      to: email,
      name,
      subject,
      htmlContent: wrapHtml(
        subject,
        `¡Hola ${escapeHtml(name)}!`,
        `<p>Recibimos tu pago y ya estamos preparando tu pedido para llevarlo a tu palco.</p>${orderSummaryHtml(order)}<div class="note">Guarda este correo como comprobante. El equipo de Servicio Palcos te entregará el pedido en el palco indicado.</div>`,
      ),
      textContent: [
        `Hola ${name},`,
        `Recibimos tu pago. Pedido ${order.orderNumber}.`,
        `Entrega: Palco ${order.delivery?.palco || ""} · ${order.delivery?.zona || ""}`,
        `Total: ${money(order.total)}`,
        "Club León - Servicio Palcos",
      ].join("\n"),
    });
  } catch (error) {
    notifyEmailFailure("sendVipOrderPaidEmail", error);
    return false;
  }
}

export async function sendVipOrderDeliveredEmail(order: VipOrder): Promise<boolean> {
  const email = order.customer?.email?.trim();
  if (!email) {
    console.error("[Brevo] Orden de palcos sin email de cliente", { orderId: order.id });
    return false;
  }
  const name = order.customer.name || "Cliente";
  const palco = order.delivery?.palco || "";
  const subject = `Pedido entregado ${order.orderNumber} - Servicio Palcos Club León`;
  try {
    return await sendBrevoEmail({
      to: email,
      name,
      subject,
      htmlContent: wrapHtml(
        subject,
        `¡Hola ${escapeHtml(name)}!`,
        `<p>Tu pedido <strong>${escapeHtml(order.orderNumber)}</strong> ya está en tu palco${palco ? ` <strong>${escapeHtml(palco)}</strong>` : ""}.</p>${orderSummaryHtml(order)}<div class="note">Si algo no coincide con lo pedido, avisa al staff de Servicio Palcos en tu zona.</div>`,
      ),
      textContent: [
        `Hola ${name},`,
        `Tu pedido ${order.orderNumber} ya está en tu palco ${palco}.`,
        `Total: ${money(order.total)}`,
        "Club León - Servicio Palcos",
      ].join("\n"),
    });
  } catch (error) {
    notifyEmailFailure("sendVipOrderDeliveredEmail", error);
    return false;
  }
}
