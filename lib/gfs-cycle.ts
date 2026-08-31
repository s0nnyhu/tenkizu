/** NOAA GFS / GEFS issuance cycle: 00, 06, 12, 18 UTC. No Open-Meteo lag. */

export const GFS_CYCLE_HOURS = 6;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${pad2(m)}:${pad2(s)}`;
}

export function gfsCycleClock(now = new Date()): {
  currentLabel: string;
  nextLabel: string;
  nextWhen: string;
  remainMs: number;
  remain: string;
} {
  const currentHour = Math.floor(now.getUTCHours() / GFS_CYCLE_HOURS) * GFS_CYCLE_HOURS;
  const currentMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    currentHour,
  );
  const nextMs = currentMs + GFS_CYCLE_HOURS * 3_600_000;
  const next = new Date(nextMs);
  const nextHour = next.getUTCHours();
  const remainMs = Math.max(0, nextMs - now.getTime());
  return {
    currentLabel: `${pad2(currentHour)}Z`,
    nextLabel: `${pad2(nextHour)}Z`,
    nextWhen: `${pad2(next.getUTCDate())}/${pad2(next.getUTCMonth() + 1)} ${pad2(nextHour)}:00 UTC`,
    remainMs,
    remain: formatCountdown(remainMs),
  };
}
