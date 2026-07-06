import type { WebClient } from "@slack/web-api";
import {
  cachePersonTimezone,
  getPersonTimezone,
  type PersonTimezone,
} from "./graph";

/** 9:00am and 5:30pm expressed as minutes-from-local-midnight. */
export const WORKDAY_START_MIN = 9 * 60; // 540
export const WORKDAY_END_MIN = 17 * 60 + 30; // 1050

const MS_PER_DAY = 86_400_000;

/**
 * Resolve a person's timezone, using the cached copy on their Neo4j node first
 * and only calling `users.info` when we've never seen them. The result is
 * written back to the graph so subsequent calls are free.
 */
export async function resolvePersonTimezone(
  client: WebClient,
  personId: string,
  teamId: string,
  personName?: string,
): Promise<PersonTimezone | null> {
  const cached = await getPersonTimezone(personId, teamId).catch(() => null);
  if (cached) return cached;

  try {
    const info = await client.users.info({ user: personId });
    const tz = info.user?.tz;
    const tzOffset = info.user?.tz_offset;
    const name =
      personName || info.user?.real_name || info.user?.name || "Unknown";
    if (typeof tz === "string" && typeof tzOffset === "number") {
      await cachePersonTimezone({
        personId,
        personName: name,
        teamId,
        timezone: tz,
        tzOffset,
      });
      return { timezone: tz, tzOffset, workdayEnd: WORKDAY_END_MIN };
    }
  } catch (err) {
    console.warn(`[timezone] users.info failed for ${personId}:`, err);
  }
  return null;
}

/**
 * Milliseconds from `now` until the next time it is `minuteOfDay` (local
 * minutes-from-midnight) in a timezone `tzOffsetSeconds` from UTC. Because the
 * offset cancels out, the delta is valid in UTC terms too.
 */
export function msUntilLocalMinuteOfDay(
  tzOffsetSeconds: number,
  minuteOfDay: number,
  now: number = Date.now(),
): number {
  const local = now + tzOffsetSeconds * 1000;
  const localMidnight = Math.floor(local / MS_PER_DAY) * MS_PER_DAY;
  let target = localMidnight + minuteOfDay * 60_000;
  if (target <= local) target += MS_PER_DAY;
  return target - local;
}

/** Unix seconds for the next occurrence of a local minute-of-day (for scheduleMessage). */
export function unixSecondsForNextLocalMinuteOfDay(
  tzOffsetSeconds: number,
  minuteOfDay: number,
  now: number = Date.now(),
): number {
  return Math.floor(
    (now + msUntilLocalMinuteOfDay(tzOffsetSeconds, minuteOfDay, now)) / 1000,
  );
}

/** Current local minutes-from-midnight for a timezone offset. */
export function localMinuteOfDay(
  tzOffsetSeconds: number,
  now: number = Date.now(),
): number {
  const local = now + tzOffsetSeconds * 1000;
  return Math.floor((local % MS_PER_DAY) / 60_000);
}

/** True when the person's local clock is inside their working day (start–end). */
export function isWithinWorkday(
  tz: PersonTimezone,
  now: number = Date.now(),
): boolean {
  const m = localMinuteOfDay(tz.tzOffset, now);
  return m >= WORKDAY_START_MIN && m < tz.workdayEnd;
}
