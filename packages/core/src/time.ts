import type { Time } from "./types.js";

/** `YYYY-MM-DDTHH:mm:ssZ`, Gregorian, years 2000-2099, whole seconds only. */

const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    default:
      return 0;
  }
}

export function isValidTime(t: unknown): t is Time {
  if (typeof t !== "string") return false;
  const m = TIME_RE.exec(t);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  if (year < 2000 || year > 2099) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
}

/** Epoch seconds for a valid Time. Caller must validate with isValidTime first. */
export function timeToEpochSeconds(t: Time): number {
  const m = TIME_RE.exec(t)!;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000;
}

export function epochSecondsToTime(sec: number): Time {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2099) throw new RangeError("time out of supported range");
  return `${y}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
}

export function nowUtcTime(): Time {
  return epochSecondsToTime(Math.floor(Date.now() / 1000));
}

/** `t + seconds` as a Time, or null when the result leaves the supported range. */
export function timeAfterSeconds(t: Time, seconds: number): Time | null {
  try {
    return epochSecondsToTime(timeToEpochSeconds(t) + seconds);
  } catch {
    return null;
  }
}
