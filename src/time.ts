// Timezone math without libraries. All conversions go through Intl at the
// moment of use, so DST transitions are handled by the platform's tz data —
// local wall times are never baked into stored UTC values across days.

export interface LocalParts {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
  hh: number;
  mm: number;
  weekday: string; // 'Sun'..'Sat'
  localDate: string; // YYYY-MM-DD
  hhmm: string; // HH:MM
  minOfDay: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const parts = fmt(tz).formatToParts(new Date(utcMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  const hh = Number(get('hour')) % 24;
  const mm = Number(get('minute'));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    y,
    m,
    d,
    hh,
    mm,
    weekday: get('weekday'),
    localDate: `${y}-${pad(m)}-${pad(d)}`,
    hhmm: `${pad(hh)}:${pad(mm)}`,
    minOfDay: hh * 60 + mm,
  };
}

// Two-pass conversion: guess UTC as if local were UTC, measure how the guess
// renders in the zone, correct by the difference. Converges in <=3 passes;
// nonexistent spring-forward times resolve one hour later.
export function utcFromLocal(tz: string, y: number, m: number, d: number, hh: number, mm: number): number {
  const target = Date.UTC(y, m - 1, d, hh, mm);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const rendered = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    const diff = rendered - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export function hhmmToMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function utcForLocalDateTime(tz: string, localDate: string, hhmm: string): number {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!dm) return NaN;
  const min = hhmmToMin(hhmm);
  return utcFromLocal(tz, Number(dm[1]), Number(dm[2]), Number(dm[3]), Math.floor(min / 60), min % 60);
}

export function addDaysLocal(tz: string, localDate: string, days: number): string {
  const noonUtc = utcForLocalDateTime(tz, localDate, '12:00');
  return localParts(noonUtc + days * 86_400_000, tz).localDate;
}

// True when `now` falls inside [start, end), supporting overnight windows
// like 22:00-07:30.
export function inWindow(nowMin: number, startHhmm: string, endHhmm: string): boolean {
  const s = hhmmToMin(startHhmm);
  const e = hhmmToMin(endHhmm);
  if (s === e) return false;
  if (s < e) return nowMin >= s && nowMin < e;
  return nowMin >= s || nowMin < e;
}

// '10am' | '4:30pm' | '16:00' | 'noon' | 'midnight' -> 'HH:MM' | null
export function parseTimeToken(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '00:00';
  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === 'pm') h += 12;
    return `${pad(h)}:${ampm[2] ?? '00'}`;
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (h24) {
    const h = Number(h24[1]);
    if (h < 24 && Number(h24[2]) < 60) return `${pad(h)}:${h24[2]}`;
  }
  return null;
}

// Pull a trailing time expression off free text: "call vendor 10am" ->
// { title: "call vendor", time: "10:00" }
export function extractTrailingTime(text: string): { title: string; time: string | null } {
  const m = /^(.*?)(?:\s+(?:at|by)\s+)?\s*((?:\d{1,2}(?::\d{2})?\s*(?:am|pm))|(?:\d{1,2}:\d{2})|noon|midnight)\s*$/i.exec(
    text.trim(),
  );
  if (m && m[1] && m[1].trim().length > 0) {
    const time = parseTimeToken(m[2] ?? '');
    if (time) return { title: m[1].trim().replace(/[,;-]\s*$/, ''), time };
  }
  return { title: text.trim(), time: null };
}
