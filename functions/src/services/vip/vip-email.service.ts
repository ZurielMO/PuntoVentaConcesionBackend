import { sendBrevoEmail } from "../../clients/brevo.client";
import { resolveVipFrontendOrigin } from "../../config/vip.config";
import { isVipPreorder, type VipOrder, type VipOrderItemSnapshot, type VipPreorderInfo } from "../../models/vip.model";
import { formatGuideCode, formatMatchDateLong, VIP_TIME_ZONE } from "./vip-preorder.utils";

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

const totalsHtml = (order: VipOrder): string => `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;font-size:14px;color:#4A5568;">
      <tr><td>Productos</td><td style="text-align:right;">${money(order.subtotal)}</td></tr>
      <tr><td>Cargo por servicio</td><td style="text-align:right;">${money(order.serviceFee)}</td></tr>
      <tr>
        <td style="padding-top:10px;font-weight:700;color:#007A53;">Total</td>
        <td style="padding-top:10px;text-align:right;font-weight:700;color:#007A53;">${money(order.total)}</td>
      </tr>
    </table>`;

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

const guideLookupUrl = (guide: string): string | null => {
  try {
    return `${resolveVipFrontendOrigin()}/servicio-palcos/guia/?codigo=${encodeURIComponent(guide)}`;
  } catch {
    return null;
  }
};

const guideBlockHtml = (order: VipOrder): string => {
  const guide = formatGuideCode(order.guideCode);
  if (!guide) return "";
  const url = guideLookupUrl(guide);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 26px;border:1px solid #E2E8F0;border-radius:14px;background-color:#F7FAF8;">
    <tr>
      <td style="padding:20px 20px 22px;text-align:center;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#9E7844;font-weight:700;">Guía de pedido</div>
        <div style="font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:28px;letter-spacing:5px;font-weight:700;color:#0A1C16;margin-top:6px;">${escapeHtml(guide)}</div>
        <div style="font-size:12px;color:#718096;margin-top:6px;">Ingrésala en la página de Servicio Palcos para ver el estatus de tu pedido.</div>
        ${url ? `<a href="${escapeHtml(url)}" style="display:inline-block;margin-top:14px;background-color:#007A53;color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;padding:10px 20px;border-radius:999px;">Consultar mi pedido</a>` : ""}
      </td>
    </tr>
  </table>`;
};

const kickoffTimeLabel = (preorder: VipPreorderInfo): string | null => {
  const millis = preorder.kickoffAt?.toMillis?.();
  if (!millis) return null;
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: VIP_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(millis));
};

const preorderBlockHtml = (preorder: VipPreorderInfo): string => {
  const kickoff = kickoffTimeLabel(preorder);
  const dateLine = [formatMatchDateLong(preorder.matchDate), kickoff ? `Inicio ${kickoff} h` : null]
    .filter(Boolean)
    .join(" · ");
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;border-radius:14px;background-color:#0A1C16;">
    <tr>
      <td style="padding:18px 20px;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#D4AF37;font-weight:700;">Preventa · Partido ${escapeHtml(String(preorder.jornadaNumero))}</div>
        <div style="font-size:18px;font-weight:700;color:#ffffff;margin-top:4px;">${escapeHtml(preorder.matchLabel)}</div>
        <div style="font-size:13px;color:#A7B8B0;margin-top:2px;text-transform:capitalize;">${escapeHtml(dateLine)}</div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #1E3A2F;">
          <span style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#A7B8B0;">Ventana de entrega</span><br/>
          <span style="font-size:22px;font-weight:700;color:#FADC06;letter-spacing:1px;">${escapeHtml(preorder.windowLabel)}</span>
        </div>
      </td>
    </tr>
  </table>`;
};

const guideTextLines = (order: VipOrder): string[] => {
  const guide = formatGuideCode(order.guideCode);
  if (!guide) return [];
  const url = guideLookupUrl(guide);
  return [`Guía de pedido: ${guide}`, ...(url ? [`Consulta el estatus: ${url}`] : [])];
};

async function sendVipPreorderPaidEmail(order: VipOrder, preorder: VipPreorderInfo): Promise<boolean> {
  const email = order.customer.email.trim();
  const name = order.customer.name || "Cliente";
  const subject = `Preventa confirmada ${order.orderNumber} - Servicio Palcos Club León`;
  try {
    return await sendBrevoEmail({
      to: email,
      name,
      subject,
      htmlContent: wrapHtml(
        subject,
        `¡Hola ${escapeHtml(name)}!`,
        `<p>Tu preventa quedó <strong>pagada y programada</strong>. Prepararemos tu pedido con anticipación para entregarlo en tu palco dentro de la ventana que elegiste.</p>${preorderBlockHtml(preorder)}${guideBlockHtml(order)}${orderSummaryHtml(order)}<div class="note">El horario es estimado: el equipo de Servicio Palcos llegará dentro de tu ventana de entrega. Te avisaremos por correo cuando tu pedido vaya en camino.</div>`,
      ),
      textContent: [
        `Hola ${name},`,
        `Tu preventa ${order.orderNumber} está pagada y programada.`,
        `Partido ${preorder.jornadaNumero} · ${preorder.matchLabel} (${formatMatchDateLong(preorder.matchDate)})`,
        `Ventana de entrega: ${preorder.windowLabel}`,
        `Entrega: Palco ${order.delivery?.palco || ""} · ${order.delivery?.zona || ""}`,
        ...guideTextLines(order),
        `Total: ${money(order.total)}`,
        "Club León - Servicio Palcos",
      ].join("\n"),
    });
  } catch (error) {
    notifyEmailFailure("sendVipPreorderPaidEmail", error);
    return false;
  }
}

export async function sendVipPreorderOnTheWayEmail(order: VipOrder): Promise<boolean> {
  const email = order.customer?.email?.trim();
  if (!email || !isVipPreorder(order)) return false;
  const name = order.customer.name || "Cliente";
  const subject = `Tu preventa va en camino ${order.orderNumber} - Servicio Palcos Club León`;
  try {
    return await sendBrevoEmail({
      to: email,
      name,
      subject,
      htmlContent: wrapHtml(
        subject,
        `¡Hola ${escapeHtml(name)}!`,
        `<p>Tu pedido <strong>${escapeHtml(order.orderNumber)}</strong> ya salió rumbo a tu palco (${deliveryLine(order)}).</p>${preorderBlockHtml(order.preorder)}${guideBlockHtml(order)}<div class="note">Ten a la mano tu guía de pedido por si el staff la solicita al entregar.</div>`,
      ),
      textContent: [
        `Hola ${name},`,
        `Tu preventa ${order.orderNumber} va en camino a tu palco ${order.delivery?.palco || ""}.`,
        `Ventana de entrega: ${order.preorder.windowLabel}`,
        ...guideTextLines(order),
        "Club León - Servicio Palcos",
      ].join("\n"),
    });
  } catch (error) {
    notifyEmailFailure("sendVipPreorderOnTheWayEmail", error);
    return false;
  }
}

export async function sendVipOrderPaidEmail(order: VipOrder): Promise<boolean> {
  const email = order.customer?.email?.trim();
  if (!email) {
    console.error("[Brevo] Orden de palcos sin email de cliente", { orderId: order.id });
    return false;
  }
  if (isVipPreorder(order)) return sendVipPreorderPaidEmail(order, order.preorder);
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
        `<p>Recibimos tu pago y ya estamos preparando tu pedido para llevarlo a tu palco.</p>${guideBlockHtml(order)}${orderSummaryHtml(order)}<div class="note">Guarda este correo como comprobante. El equipo de Servicio Palcos te entregará el pedido en el palco indicado.</div>`,
      ),
      textContent: [
        `Hola ${name},`,
        `Recibimos tu pago. Pedido ${order.orderNumber}.`,
        `Entrega: Palco ${order.delivery?.palco || ""} · ${order.delivery?.zona || ""}`,
        ...guideTextLines(order),
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
