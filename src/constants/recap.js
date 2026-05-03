// === Recap mode constants ===
// Keep recap mode option payloads and labels consistent across commands.
export const RECAP_MODE_CHOICES = [
  { name: "Daily (last 24h)", value: "DAILY" },
  { name: "Weekly (last 7d)", value: "WEEKLY" },
];

export const VALID_RECAP_MODES = new Set(RECAP_MODE_CHOICES.map((choice) => choice.value));

export function modeLabel(mode) {
  return mode === "WEEKLY" ? "Weekly" : "Daily";
}

export function hoursForMode(mode) {
  return mode === "WEEKLY" ? 24 * 7 : 24;
}

// Format recap schedule time in a consistent human-readable 12-hour clock.
export function formatRecapScheduleTime(hour, minute) {
  const normalizedHour = Number(hour ?? 0);
  const normalizedMinute = Number(minute ?? 0);

  const suffix = normalizedHour >= 12 ? "PM" : "AM";
  const hour12 = normalizedHour % 12 || 12;
  const minutePadded = String(normalizedMinute).padStart(2, "0");

  return `${hour12}:${minutePadded} ${suffix}`;
}
