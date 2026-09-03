export function toOffset(utcIso: string, offset: string): string {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad offset: ${offset}`);
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) throw new Error(`bad date: ${utcIso}`);
  const sign = m[1] === "-" ? -1 : 1;
  const minutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  const shifted = new Date(ms + minutes * 60_000);
  return shifted.toISOString().slice(0, 19) + offset;
}

export function localOffset(d: Date = new Date()): string {
  const minutes = -d.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export const isDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export const isOffset = (s: string): boolean => /^[+-]\d{2}:\d{2}$/.test(s);
