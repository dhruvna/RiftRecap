// === Recap mode constants ===
// Keep recap mode option payloads and labels consistent across commands.
export const RECAP_MODE_CHOICES = [
  { name: "Daily (last 24h)", value: "DAILY" },
  { name: "Weekly (last 7d)", value: "WEEKLY" },
  { name: "Daily + Weekly", value: "BOTH" },
];

// Slash command `/recap` should only allow direct daily/weekly requests.
export const RECAP_COMMAND_MODE_CHOICES = RECAP_MODE_CHOICES.filter((choice) => choice.value !== "BOTH");

export const VALID_RECAP_MODES = new Set(RECAP_MODE_CHOICES.map((choice) => choice.value));
export const DEFAULT_RECAP_MODE = "DAILY";

export function invalidRecapModeMessage(rawMode) {
  const shown = rawMode == null ? "null" : String(rawMode);
  return `Invalid mode \`${shown}\`. Allowed values: ${[...VALID_RECAP_MODES].join(", ")}.`;
}

export function parseRecapMode(rawMode) {
  if (rawMode == null) return DEFAULT_RECAP_MODE;
  const normalized = String(rawMode).trim().toUpperCase();
  return VALID_RECAP_MODES.has(normalized) ? normalized : DEFAULT_RECAP_MODE;
}

export function resolveRecapModeOrError(rawMode, { allowNull = false } = {}) {
  if (rawMode == null) {
    return allowNull
      ? { ok: true, mode: null }
      : { ok: true, mode: DEFAULT_RECAP_MODE };
  }

  const normalized = String(rawMode).trim().toUpperCase();
  if (!VALID_RECAP_MODES.has(normalized)) {
    return { ok: false, error: invalidRecapModeMessage(rawMode) };
  }

  return { ok: true, mode: normalized };
}

export function modeLabel(mode) {
  // return parseRecapMode(mode) === "WEEKLY" ? "Weekly" : "Daily";
  const normalized = parseRecapMode(mode);
  if (normalized === "WEEKLY") return "Weekly";
  if (normalized === "BOTH") return "Daily + Weekly";
  return "Daily";

}

export function hoursForMode(mode) {
  return parseRecapMode(mode) === "WEEKLY" ? 24 * 7 : 24;
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
