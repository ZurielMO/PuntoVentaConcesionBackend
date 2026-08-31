import { onSchedule } from "firebase-functions/v2/scheduler";
import { expireReservations } from "./services/vip/vip.service";

/** Releases unpaid VIP stock holds after their configured expiry time. */
export const expireVipReservations = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/Mexico_City",
    memory: "512MiB",
  },
  async () => {
    let expiredOrders = 0;
    let reservations = 0;
    // Drain bounded pages without allowing one invocation to run forever.
    for (let page = 0; page < 10; page += 1) {
      const result = await expireReservations(100);
      expiredOrders += result.expiredOrders;
      reservations += result.reservations;
      if (result.reservations < 100) break;
    }
    console.info("vip_reservations_expired", {
      action: "expire_reservations",
      status: "COMPLETED",
      expiredOrders,
      reservations,
    });
  },
);
