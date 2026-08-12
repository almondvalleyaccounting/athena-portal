/*
  cronSchedule.js — read a 5-field cron expression well enough to say
  "every 5 minutes between 01:00 and 04:00" and "next due Thursday 08:00".

  Everything here works in UTC because pg_cron on Supabase runs in UTC:
  the database's TimeZone is UTC, so "0 8 * * *" is 08:00 UTC year round,
  which is 09:00 in London through British Summer Time. The page shows both
  so nobody has to hold that in their head.
*/

const FIELD_RANGES = [
  [0, 59],  // minute
  [0, 23],  // hour
  [1, 31],  // day of month
  [1, 12],  // month
  [0, 6],   // day of week (0 = Sunday)
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/* Parse one field into { values: number[], isWildcard, step } */
function parseField(raw, index) {
  const [min, max] = FIELD_RANGES[index];
  const values = new Set();
  let step = null;
  let isWildcard = true;

  for (const chunk of String(raw).split(',')) {
    const [rangePart, stepPart] = chunk.split('/');
    const s = stepPart ? parseInt(stepPart, 10) : 1;
    if (stepPart) step = s;

    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      isWildcard = false;
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        lo = parseInt(a, 10);
        hi = parseInt(b, 10);
      } else {
        lo = parseInt(rangePart, 10);
        hi = lo;
      }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
    if (stepPart && s > 1) isWildcard = false;
    for (let v = lo; v <= hi; v += s) values.add(v === 7 && index === 4 ? 0 : v);
  }

  return { values: [...values].sort((a, b) => a - b), isWildcard, step };
}

export function parseCron(expr) {
  if (!expr) return null;
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map(parseField);
  if (parsed.some((p) => !p || p.values.length === 0)) return null;
  return {
    raw: expr,
    minute: parsed[0],
    hour: parsed[1],
    dom: parsed[2],
    month: parsed[3],
    dow: parsed[4],
  };
}

/* Does this UTC date fall on a day the schedule runs?
   Standard cron rule: when day-of-month AND day-of-week are both restricted
   the job runs if EITHER matches; otherwise both must match. */
function dayMatches(c, date) {
  if (!c.month.values.includes(date.getUTCMonth() + 1)) return false;
  const domOk = c.dom.values.includes(date.getUTCDate());
  const dowOk = c.dow.values.includes(date.getUTCDay());
  if (!c.dom.isWildcard && !c.dow.isWildcard) return domOk || dowOk;
  return domOk && dowOk;
}

/* Next fire time strictly after `from`, as a Date in UTC. Null if it will
   not fire within two years (a schedule like "29 Feb" on a bad cycle). */
export function nextRun(expr, from = new Date()) {
  const c = parseCron(expr);
  if (!c) return null;

  let day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 0; i < 800; i += 1) {
    if (dayMatches(c, day)) {
      for (const h of c.hour.values) {
        for (const m of c.minute.values) {
          const t = new Date(Date.UTC(
            day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m, 0, 0,
          ));
          if (t.getTime() > from.getTime()) return t;
        }
      }
    }
    day = new Date(day.getTime() + 24 * 3600 * 1000);
  }
  return null;
}

/* ── Humanising ─────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');

function listWithAnd(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function contiguous(values, min, max) {
  if (values.length < 2) return null;
  const lo = values[0];
  const hi = values[values.length - 1];
  if (lo === min && hi === max) return null;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1] + 1) return null;
  }
  return [lo, hi];
}

function hoursPhrase(hour) {
  if (hour.isWildcard) return '';
  const v = hour.values;
  const span = contiguous(v, 0, 23);
  if (span) return `between ${pad(span[0])}:00 and ${pad(span[1])}:59`;
  if (hour.step && hour.step > 1) return `every ${hour.step} hours`;
  return `at ${listWithAnd(v.map((h) => `${pad(h)}:00`))}`;
}

function timePhrase(c) {
  const { minute, hour } = c;

  if (minute.isWildcard) {
    const h = hoursPhrase(hour);
    return h ? `Every minute ${h}` : 'Every minute';
  }

  if (minute.step && minute.step > 1 && minute.values.length > 2) {
    const h = hoursPhrase(hour);
    return h ? `Every ${minute.step} minutes ${h}` : `Every ${minute.step} minutes`;
  }

  if (hour.isWildcard) {
    return `At ${listWithAnd(minute.values.map((m) => `:${pad(m)}`))} past every hour`;
  }

  const times = [];
  for (const h of hour.values) {
    for (const m of minute.values) times.push(`${pad(h)}:${pad(m)}`);
  }
  if (times.length <= 4) return `At ${listWithAnd(times)}`;
  return `At ${listWithAnd(minute.values.map((m) => `:${pad(m)}`))} past ${hoursPhrase(hour)}`;
}

function dayPhrase(c) {
  const bits = [];

  if (!c.dow.isWildcard) {
    const v = c.dow.values;
    const span = contiguous(v, 0, 6);
    if (v.length === 5 && v.join() === '1,2,3,4,5') bits.push('Monday to Friday');
    else if (span) bits.push(`${DAY_NAMES[span[0]]} to ${DAY_NAMES[span[1]]}`);
    else bits.push(listWithAnd(v.map((d) => DAY_NAMES[d])));
  }

  if (!c.dom.isWildcard) {
    bits.push(`the ${listWithAnd(c.dom.values.map(ordinal))} of the month`);
  }

  if (!c.month.isWildcard) {
    bits.push(`in ${listWithAnd(c.month.values.map((m) => MONTH_NAMES[m - 1]))}`);
  }

  if (bits.length === 0) return 'every day';
  // "Monday to Friday" / "the 10th of the month" read fine after "on";
  // "in January and July" carries its own preposition.
  return bits
    .map((b, i) => (b.startsWith('in ') ? b : `${i === 0 ? 'on ' : ''}${b}`))
    .join(', ');
}

export function describeCron(expr) {
  const c = parseCron(expr);
  if (!c) return expr || '—';
  const time = timePhrase(c);
  const day = dayPhrase(c);
  if (day === 'every day') {
    // "Every 5 minutes" and "…past every hour" already say it; a fixed
    // clock time doesn't, so that one gets "every day" tacked on.
    const selfEvident = /^Every /.test(time) || /every hour$/.test(time);
    return selfEvident ? time : `${time}, every day`;
  }
  return `${time}, ${day}`;
}

/* ── Formatting helpers ─────────────────────────────────────────────── */

export function formatLondon(date) {
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/London',
  }).format(date);
}

export function formatUtcTime(date) {
  if (!date) return '';
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export function relativeTo(date, now = new Date()) {
  if (!date) return '';
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const past = diff < 0;

  let text;
  if (mins < 1) text = 'less than a minute';
  else if (mins < 60) text = `${mins} min`;
  else if (mins < 60 * 36) {
    const h = Math.round(mins / 60);
    text = `${h} hour${h === 1 ? '' : 's'}`;
  } else {
    const d = Math.round(mins / 1440);
    text = `${d} day${d === 1 ? '' : 's'}`;
  }
  return past ? `${text} ago` : `in ${text}`;
}
