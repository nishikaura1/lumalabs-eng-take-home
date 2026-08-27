import { config } from "../config.js";

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Gates *notifications*, not generation. Generation keeps queuing and
 * running around the clock (bounded by the backlog cap, not the clock) so
 * shots are ready and waiting the moment work hours start — only the ping
 * to Ellie's phone is held back outside config.workHours.
 */
export function isWorkHours(date: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.teamTimezone,
    hour: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);

  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const day = WEEKDAY_INDEX[weekday] ?? 0;

  return (
    config.workHours.workDays.includes(day) &&
    hour >= config.workHours.startHour &&
    hour < config.workHours.endHour
  );
}
