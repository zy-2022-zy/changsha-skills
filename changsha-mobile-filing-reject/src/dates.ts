export type DateRange = { start: string; end: string; basis: string };
export function dateFolder(range?: DateRange): string {
  return !range ? beijingToday() : range.start === range.end ? range.start : `${range.start}_至_${range.end}`;
}

export function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期必须为 YYYY-MM-DD。');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`无效日期：${value}`);
  return value;
}

export function beijingToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function dateRange(options: { date?: string; start?: string; end?: string; today?: string }): DateRange {
  if (options.date && (options.start || options.end)) throw new Error('--date 与 --start/--end 不可混用。');
  if (options.date) return { start: validDate(options.date), end: validDate(options.date), basis: '显式日期' };
  if (options.start || options.end) {
    if (!options.start || !options.end) throw new Error('--start 和 --end 必须同时提供。');
    const start = validDate(options.start), end = validDate(options.end);
    if (start > end) throw new Error('开始日期不能晚于结束日期。');
    return { start, end, basis: '显式日期范围' };
  }
  const date = new Date(`${validDate(options.today ?? beijingToday())}T00:00:00Z`);
  do { date.setUTCDate(date.getUTCDate() - 1); } while ([0, 6].includes(date.getUTCDay()));
  const day = date.toISOString().slice(0, 10);
  return { start: day, end: day, basis: '前一工作日（仅排除周六日，法定节假日和调休请显式指定日期）' };
}
