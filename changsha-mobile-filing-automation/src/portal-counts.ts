function count(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return undefined;
  const result = Number(text.replaceAll(',', ''));
  return Number.isSafeInteger(result) ? result : undefined;
}

export function parsePortalCounts(totalText: string | undefined, succeededText: string | undefined, failedText: string | undefined, completed: boolean) {
  const total = count(totalText);
  const succeeded = count(succeededText);
  let failed = count(failedText);
  // 仅补全门户全部成功时的空白单元格；缺列及非法文本不视为零。
  if (completed && failedText !== undefined && failedText.trim() === ''
    && total !== undefined && succeeded !== undefined && total === succeeded) failed = 0;
  return { total, succeeded, failed };
}
