import {
  buildPreorderMatch,
  buildPreorderSlots,
  DEFAULT_VIP_PREORDER_SETTINGS,
  formatGuideCode,
  generateGuideCode,
  normalizeGuideCode,
  normalizeMatchDate,
  normalizePreorderSettings,
  parseKickoffMinutes,
  stadiumLocalToMillis,
} from "../src/services/vip/vip-preorder.utils";
import { vipCheckoutSchema, VIP_LEGAL_DOCUMENT_VERSION } from "../src/middleware/validators/vip.validator";

describe("VIP preorder rules", () => {
  it.each([
    ["19:00", 19 * 60],
    ["19:00 hrs", 19 * 60],
    ["7:05 PM", 19 * 60 + 5],
    ["7:05pm", 19 * 60 + 5],
    ["12:30 a.m.", 30],
    ["1900", 19 * 60],
    ["21h05", 21 * 60 + 5],
    ["2026-10-04T20:15:00-06:00", 20 * 60 + 15],
    ["", null],
    ["por definir", null],
    ["25:00", null],
  ])("parses kickoff %p", (raw, expected) => {
    expect(parseKickoffMinutes(raw)).toBe(expected);
  });

  it("normalizes acreditaciones dates", () => {
    expect(normalizeMatchDate("04/10/2026")).toBe("2026-10-04");
    expect(normalizeMatchDate("2026-10-04T19:00:00")).toBe("2026-10-04");
    expect(normalizeMatchDate("mañana")).toBeNull();
  });

  it("converts stadium local time to UTC (Mexico City has no DST since 2022)", () => {
    expect(new Date(stadiumLocalToMillis("2026-10-04", 19 * 60)).toISOString()).toBe("2026-10-05T01:00:00.000Z");
    expect(new Date(stadiumLocalToMillis("2026-01-15", 8 * 60)).toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("never allows windows shorter than 25 minutes nor overlapping windows", () => {
    const settings = normalizePreorderSettings({ slotMinutes: 10, slotStepMinutes: 5, leadMinutes: 1 });
    expect(settings.slotMinutes).toBe(25);
    expect(settings.slotStepMinutes).toBeGreaterThanOrEqual(settings.slotMinutes);
    expect(settings.leadMinutes).toBeGreaterThanOrEqual(25);
    expect(normalizePreorderSettings({ enabled: false }).enabled).toBe(false);
    expect(normalizePreorderSettings(undefined)).toEqual(DEFAULT_VIP_PREORDER_SETTINGS);
  });

  it("builds windows around kickoff and closes them inside the lead time", () => {
    const settings = normalizePreorderSettings(undefined);
    const match = buildPreorderMatch("2026-10-04__J11", "2026-10-04", 11, {
      hora: "19:05", equipo_local: "León", equipo_visitante: "Puebla",
    }, undefined, settings);
    expect(match).toMatchObject({ matchLabel: "León vs Puebla", firstStartMinutes: 18 * 60 + 15 });
    const kickoff = match!.kickoffAt!;
    const slots = buildPreorderSlots(match!, settings, kickoff - 3 * 60 * 60_000);
    expect(slots.map((slot) => slot.label)).toEqual([
      "18:15 – 18:40", "18:45 – 19:10", "19:15 – 19:40",
    ]);
    expect(slots.every((slot) => slot.endAt - slot.startAt === 25 * 60_000)).toBe(true);
    expect(slots.every((slot) => slot.startAt >= kickoff - 50 * 60_000)).toBe(true);
    expect(slots.every((slot) => slot.endAt <= kickoff + 50 * 60_000)).toBe(true);
    expect(slots.every((slot) => slot.bookable)).toBe(true);

    const nearKickoff = buildPreorderSlots(match!, settings, kickoff - 80 * 60_000);
    expect(nearKickoff.filter((slot) => slot.bookable).map((slot) => slot.start)).toEqual(["18:45", "19:15"]);
  });

  it("uses explicit match overrides and never invents hours without kickoff", () => {
    const settings = normalizePreorderSettings(undefined);
    expect(buildPreorderMatch("m", "2026-10-04", 1, {}, undefined, settings)).toBeNull();
    const overridden = buildPreorderMatch("m", "2026-10-04", 1, {}, {
      windowStart: "17:10", windowEnd: "18:10", slotCapacity: 3,
    }, settings);
    expect(overridden).toMatchObject({ firstStartMinutes: 17 * 60 + 10, slotCapacity: 3 });
    expect(buildPreorderMatch("m", "2026-10-04", 1, { hora: "19:00" }, { enabled: false }, settings)).toBeNull();
  });

  it("generates unambiguous 8-char guide codes and normalizes customer input", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateGuideCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(normalizeGuideCode(" 7kq4-m2xd ")).toBe("7KQ4M2XD");
    expect(normalizeGuideCode("7KQ4-M2XO")).toBe("7KQ4M2X0");
    expect(normalizeGuideCode("7KQ4-M2XU")).toBeNull();
    expect(normalizeGuideCode("123")).toBeNull();
    expect(formatGuideCode("7KQ4M2XD")).toBe("7KQ4-M2XD");
  });

  it("accepts only matchId + HH:mm as preorder input (no client-side window or price)", () => {
    const base = {
      customer: { name: "Cliente", email: "c@example.com", phone: "4771234567" },
      delivery: { zona: "Poniente", palco: "12", nivel: "2" },
      items: [{ productId: "p1", quantity: 1 }],
      legalAcceptance: { accepted: true, version: VIP_LEGAL_DOCUMENT_VERSION },
    };
    expect(vipCheckoutSchema.safeParse({ ...base, preorder: { matchId: "m1", windowStart: "19:00" } }).success).toBe(true);
    expect(vipCheckoutSchema.safeParse({ ...base, preorder: { matchId: "m1", windowStart: "7pm" } }).success).toBe(false);
    expect(vipCheckoutSchema.safeParse({
      ...base,
      preorder: { matchId: "m1", windowStart: "19:00", windowEnd: "19:05" },
    }).success).toBe(false);
  });
});
