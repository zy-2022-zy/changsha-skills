import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { DATA_START_ROW, MAX_DATA_ROWS, MAX_UPLOAD_BYTES, TEMPLATE_SHEET } from './validation.js';

export const MAX_SOURCE_WORKBOOK_BYTES = 200 * 1024 * 1024;

export type SplitWorkbookOptions = {
  maxBytes?: number;
  maxRows?: number;
  outputRoot?: string;
};

export type SplitWorkbookPart = {
  path: string;
  fileName: string;
  index: number;
  total: number;
  dataRows: number;
  sizeBytes: number;
};

export type SplitWorkbookResult = {
  sourcePath: string;
  split: boolean;
  parts: SplitWorkbookPart[];
};

type XmlRow = { rowNumber: number; xml: string };

type WorkbookParts = {
  worksheetPath: string;
  worksheetXml: string;
  headerRows: XmlRow[];
  dataRows: XmlRow[];
};

function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributes(xmlTag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of xmlTag.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
    result.set(match[1], xmlUnescape(match[3]));
  }
  return result;
}

function normalizeZipPath(value: string): string {
  return path.posix.normalize(value.replace(/^\//, '')).replace(/^\.\//, '');
}

function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith('/')) return normalizeZipPath(target);
  return normalizeZipPath(path.posix.join(path.posix.dirname(sourcePart), target));
}

function relationshipsPath(sourcePart: string): string {
  return path.posix.join(path.posix.dirname(sourcePart), '_rels', `${path.posix.basename(sourcePart)}.rels`);
}

function relationshipTarget(relsXml: string, relationshipId: string, sourcePart: string): string | undefined {
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.get('Id') === relationshipId && attrs.get('TargetMode') !== 'External') {
      const target = attrs.get('Target');
      return target ? resolveTarget(sourcePart, target) : undefined;
    }
  }
  return undefined;
}

function rowNumber(rowXml: string): number | undefined {
  const openingTag = rowXml.match(/^<row\b[^>]*>/)?.[0] ?? rowXml.match(/^<row\b[^>]*\/>/)?.[0];
  const value = openingTag ? attributes(openingTag).get('r') : undefined;
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

function rowHasBusinessData(rowXml: string): boolean {
  return /<(?:v|is|f|t)\b/i.test(rowXml);
}

async function readWorkbookParts(zip: JSZip): Promise<WorkbookParts> {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const workbookRelsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string');
  if (!workbookXml || !workbookRelsXml) throw new Error('Excel 文件结构不完整：缺少工作簿定义。');

  let sheetRelationshipId: string | undefined;
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?\s*>/g)) {
    const attrs = attributes(match[0]);
    if (attrs.get('name') === TEMPLATE_SHEET) {
      sheetRelationshipId = attrs.get('r:id');
      break;
    }
  }
  if (!sheetRelationshipId) throw new Error(`Excel 缺少工作表“${TEMPLATE_SHEET}”。`);
  const worksheetPath = relationshipTarget(workbookRelsXml, sheetRelationshipId, 'xl/workbook.xml');
  if (!worksheetPath) throw new Error(`Excel 工作表“${TEMPLATE_SHEET}”的引用关系无效。`);
  const worksheetXml = await zip.file(worksheetPath)?.async('string');
  if (!worksheetXml) throw new Error(`Excel 工作表文件不存在：${worksheetPath}`);

  const sheetData = worksheetXml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!sheetData) throw new Error('Excel 主表缺少 sheetData 数据区。');
  const rows: XmlRow[] = [];
  for (const match of sheetData[1].matchAll(/<row\b[^>]*>[\s\S]*?<\/row>|<row\b[^>]*\/>/g)) {
    const number = rowNumber(match[0]);
    if (number) rows.push({ rowNumber: number, xml: match[0] });
  }
  const headerRows = rows.filter((row) => row.rowNumber < DATA_START_ROW);
  const dataRows = rows.filter((row) => row.rowNumber >= DATA_START_ROW && rowHasBusinessData(row.xml));
  return { worksheetPath, worksheetXml, headerRows, dataRows };
}

function replaceAttribute(tag: string, name: string, value: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(\\s${escapedName}\\s*=\\s*["'])[^"']*(["'])`);
  if (pattern.test(tag)) return tag.replace(pattern, `$1${value}$2`);
  return tag.replace(/\s*\/?\s*>$/, (ending) => ` ${name}="${value}"${ending}`);
}

function remapRow(row: XmlRow, newRowNumber: number): string {
  let xml = row.xml.replace(/^<row\b[^>]*\/?\s*>/, (tag) => replaceAttribute(tag, 'r', String(newRowNumber)));
  xml = xml.replace(/(<c\b[^>]*\br\s*=\s*["'])(\$?[A-Z]{1,3}\$?)\d+(["'])/gi, `$1$2${newRowNumber}$3`);
  return xml;
}

function replaceSheetData(worksheetXml: string, headerRows: XmlRow[], selectedRows: XmlRow[]): { xml: string; rowMap: Map<number, number> } {
  const rowMap = new Map<number, number>();
  const remapped = selectedRows.map((row, index) => {
    const newRow = DATA_START_ROW + index;
    rowMap.set(row.rowNumber, newRow);
    return remapRow(row, newRow);
  });
  const content = [...headerRows.map((row) => row.xml), ...remapped].join('');
  let xml = worksheetXml.replace(/(<sheetData\b[^>]*>)[\s\S]*?(<\/sheetData>)/, `$1${content}$2`);
  const lastRow = selectedRows.length > 0 ? DATA_START_ROW + selectedRows.length - 1 : DATA_START_ROW - 1;
  xml = xml.replace(/(<dimension\b[^>]*\bref\s*=\s*["'])([^"']+)(["'])/, (_whole, start: string, ref: string, end: string) => {
    const first = ref.includes(':') ? ref.split(':')[0] : 'A1';
    const lastCell = ref.includes(':') ? ref.split(':')[1] : ref;
    const lastColumn = lastCell.match(/\$?([A-Z]{1,3})/i)?.[1] ?? 'AP';
    return `${start}${first}:${lastColumn}${lastRow}${end}`;
  });
  xml = xml.replace(/(<autoFilter\b[^>]*\bref\s*=\s*["'])([^"']+)(["'])/, (_whole, start: string, ref: string, end: string) => {
    const first = ref.includes(':') ? ref.split(':')[0] : ref;
    const lastCell = ref.includes(':') ? ref.split(':')[1] : ref;
    const lastColumn = lastCell.match(/\$?([A-Z]{1,3})/i)?.[1] ?? 'AP';
    return `${start}${first}:${lastColumn}${lastRow}${end}`;
  });
  return { xml, rowMap };
}

function remapDrawingXml(drawingXml: string, rowMap: Map<number, number>): string {
  return drawingXml.replace(/<xdr:(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/xdr:\1>/g, (anchor) => {
    const from = anchor.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<\/xdr:from>/);
    if (!from) return anchor;
    const sourceExcelRow = Number(from[1]) + 1;
    if (sourceExcelRow < DATA_START_ROW) return anchor;
    const newExcelRow = rowMap.get(sourceExcelRow);
    if (!newExcelRow) return '';
    const delta = newExcelRow - sourceExcelRow;
    return anchor.replace(/(<xdr:row>)(\d+)(<\/xdr:row>)/g, (_match: string, before: string, value: string, after: string) => {
      return `${before}${Math.max(0, Number(value) + delta)}${after}`;
    });
  });
}

function usedRelationshipIds(xml: string): Set<string> {
  const ids = new Set<string>();
  for (const match of xml.matchAll(/\br:(?:id|embed|link)\s*=\s*["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

function filterRelationships(relsXml: string, usedIds: Set<string>): string {
  return relsXml.replace(/<Relationship\b[^>]*\/?\s*>/g, (relationship) => {
    const id = attributes(relationship).get('Id');
    return id && !usedIds.has(id) ? '' : relationship;
  });
}

function sourcePartForRelationships(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const directory = path.posix.dirname(path.posix.dirname(relsPath));
  const fileName = path.posix.basename(relsPath).replace(/\.rels$/i, '');
  return normalizeZipPath(path.posix.join(directory, fileName));
}

async function pruneCellImages(zip: JSZip): Promise<void> {
  // WPS DISPIMG 引用位于单元格公式或共享字符串，不能按浮动图片锚点处理。
  const references = (await Promise.all(Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name) || name === 'xl/sharedStrings.xml')
    .map((name) => zip.file(name)!.async('string')))).join('\n');
  const imagePath = 'xl/cellimages.xml';
  const xml = await zip.file(imagePath)?.async('string');
  if (!xml) return;
  const filtered = xml.replace(/<([\w]+):cellImage\b[^>]*>[\s\S]*?<\/\1:cellImage>/g, (entry) => {
    const tag = entry.match(/<(?:\w+:)?cNvPr\b[^>]*>/)?.[0];
    const name = tag ? attributes(tag).get('name') : undefined;
    // 无法识别的对象保留，避免损坏未知扩展资源。
    return !name || xmlUnescape(references).includes(name) ? entry : '';
  });
  zip.file(imagePath, filtered);
  const relsPath = relationshipsPath(imagePath);
  const rels = await zip.file(relsPath)?.async('string');
  if (rels) zip.file(relsPath, filterRelationships(rels, usedRelationshipIds(filtered)));
}

async function pruneUnusedMedia(zip: JSZip): Promise<void> {
  const usedMedia = new Set<string>();
  for (const fileName of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
    const relsXml = await zip.file(fileName)?.async('string');
    if (!relsXml) continue;
    const sourcePart = sourcePartForRelationships(fileName);
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
      const attrs = attributes(match[0]);
      if (attrs.get('TargetMode') === 'External') continue;
      const target = attrs.get('Target');
      if (!target) continue;
      const resolved = resolveTarget(sourcePart, target);
      if (resolved.startsWith('xl/media/')) usedMedia.add(resolved);
    }
  }
  for (const fileName of Object.keys(zip.files).filter((name) => name.startsWith('xl/media/') && !name.endsWith('/'))) {
    if (!usedMedia.has(fileName)) zip.remove(fileName);
  }
}

async function compactSharedStrings(zip: JSZip): Promise<void> {
  const sharedStringsPath = 'xl/sharedStrings.xml';
  const sharedStringsXml = await zip.file(sharedStringsPath)?.async('string');
  if (!sharedStringsXml) return;
  const opening = sharedStringsXml.match(/<sst\b[^>]*>/)?.[0];
  const closing = sharedStringsXml.match(/<\/sst>/)?.[0];
  if (!opening || !closing) return;
  const sourceStrings = [...sharedStringsXml.matchAll(/<si\b[^>]*>[\s\S]*?<\/si>/g)].map((match) => match[0]);
  const oldToNew = new Map<number, number>();
  let referenceCount = 0;
  for (const worksheetPath of Object.keys(zip.files).filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))) {
    const worksheetXml = await zip.file(worksheetPath)?.async('string');
    if (!worksheetXml) continue;
    const remapped = worksheetXml.replace(/<c\b(?=[^>]*\bt\s*=\s*["']s["'])[^>]*>[\s\S]*?<\/c>/g, (cell) => {
      const valueMatch = cell.match(/(<v\b[^>]*>)(\d+)(<\/v>)/);
      if (!valueMatch) return cell;
      const oldIndex = Number(valueMatch[2]);
      if (!sourceStrings[oldIndex]) return cell;
      let newIndex = oldToNew.get(oldIndex);
      if (newIndex === undefined) {
        newIndex = oldToNew.size;
        oldToNew.set(oldIndex, newIndex);
      }
      referenceCount += 1;
      return cell.replace(valueMatch[0], `${valueMatch[1]}${newIndex}${valueMatch[3]}`);
    });
    zip.file(worksheetPath, remapped);
  }
  const compactedStrings = [...oldToNew.keys()].map((oldIndex) => sourceStrings[oldIndex]).join('');
  let newOpening = replaceAttribute(opening, 'count', String(referenceCount));
  newOpening = replaceAttribute(newOpening, 'uniqueCount', String(oldToNew.size));
  zip.file(sharedStringsPath, `${sharedStringsXml.slice(0, sharedStringsXml.indexOf(opening))}${newOpening}${compactedStrings}${closing}`);
}

async function createPartBuffer(source: Buffer, parts: WorkbookParts, selectedRows: XmlRow[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(source);
  const replacement = replaceSheetData(parts.worksheetXml, parts.headerRows, selectedRows);
  zip.file(parts.worksheetPath, replacement.xml);

  const worksheetRelsPath = relationshipsPath(parts.worksheetPath);
  const worksheetRelsXml = await zip.file(worksheetRelsPath)?.async('string');
  if (worksheetRelsXml) {
    const drawingIds = [...replacement.xml.matchAll(/<drawing\b[^>]*\br:id\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
    for (const drawingId of drawingIds) {
      const drawingPath = relationshipTarget(worksheetRelsXml, drawingId, parts.worksheetPath);
      if (!drawingPath) continue;
      const drawingXml = await zip.file(drawingPath)?.async('string');
      if (!drawingXml) continue;
      const filteredDrawing = remapDrawingXml(drawingXml, replacement.rowMap);
      zip.file(drawingPath, filteredDrawing);
      const drawingRelsPath = relationshipsPath(drawingPath);
      const drawingRelsXml = await zip.file(drawingRelsPath)?.async('string');
      if (drawingRelsXml) zip.file(drawingRelsPath, filterRelationships(drawingRelsXml, usedRelationshipIds(filteredDrawing)));
    }
  }
  await compactSharedStrings(zip);
  await pruneCellImages(zip);
  await pruneUnusedMedia(zip);
  // 重启后重新拆分必须保持相同哈希，才能续用已提交分片的批次号。
  for (const entry of Object.values(zip.files)) entry.date = new Date('2000-01-01T00:00:00Z');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

export async function splitWorkbookIfNeeded(filePath: string, options: SplitWorkbookOptions = {}): Promise<SplitWorkbookResult> {
  const sourcePath = path.resolve(filePath);
  if (path.extname(sourcePath).toLowerCase() !== '.xlsx') throw new Error('拆分仅支持 .xlsx 文件。');
  const metadata = await stat(sourcePath);
  if (!metadata.isFile()) throw new Error(`不是普通文件：${sourcePath}`);
  if (metadata.size === 0) throw new Error('Excel 文件为空，无法拆分。');
  if (metadata.size > MAX_SOURCE_WORKBOOK_BYTES) throw new Error(`源 Excel 文件超过 ${MAX_SOURCE_WORKBOOK_BYTES} 字节安全限制，无法处理。`);

  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const maxRows = options.maxRows ?? MAX_DATA_ROWS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes 必须是正整数。');
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new Error('maxRows 必须是正整数。');

  const source = await readFile(sourcePath);
  const zip = await JSZip.loadAsync(source);
  const workbookParts = await readWorkbookParts(zip);
  if (workbookParts.dataRows.length === 0) {
    return {
      sourcePath,
      split: false,
      parts: [{ path: sourcePath, fileName: path.basename(sourcePath), index: 1, total: 1, dataRows: 0, sizeBytes: source.length }],
    };
  }
  if (workbookParts.dataRows.length <= maxRows && source.length <= maxBytes) {
    return {
      sourcePath,
      split: false,
      parts: [{ path: sourcePath, fileName: path.basename(sourcePath), index: 1, total: 1, dataRows: workbookParts.dataRows.length, sizeBytes: source.length }],
    };
  }

  const generated: Array<{ buffer: Buffer; dataRows: number }> = [];
  let startIndex = 0;
  while (startIndex < workbookParts.dataRows.length) {
    const remaining = workbookParts.dataRows.length - startIndex;
    const upper = Math.min(maxRows, remaining);
    const cache = new Map<number, Buffer>();
    const candidate = async (count: number): Promise<Buffer> => {
      const cached = cache.get(count);
      if (cached) return cached;
      const buffer = await createPartBuffer(source, workbookParts, workbookParts.dataRows.slice(startIndex, startIndex + count));
      cache.set(count, buffer);
      return buffer;
    };

    let low = 1;
    let high = upper;
    let bestCount = 0;
    let bestBuffer: Buffer | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const buffer = await candidate(middle);
      if (buffer.length <= maxBytes) {
        bestCount = middle;
        bestBuffer = buffer;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (!bestBuffer || bestCount === 0) {
      const oneRowSize = (await candidate(1)).length;
      throw new Error(`即使只保留 1 条数据，拆分文件仍有 ${oneRowSize} 字节，无法满足 ${maxBytes} 字节大小限制；请压缩该行图片或附件后重试。`);
    }
    generated.push({ buffer: bestBuffer, dataRows: bestCount });
    startIndex += bestCount;
  }

  const extension = path.extname(sourcePath);
  const stem = path.basename(sourcePath, extension);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const outputRoot = path.resolve(options.outputRoot ?? path.join(path.dirname(sourcePath), '拆分临时文件'));
  const outputDirectory = path.join(outputRoot, `${stem}-${digest}`);
  await mkdir(outputDirectory, { recursive: true });
  const total = generated.length;
  const parts: SplitWorkbookPart[] = [];
  for (let index = 0; index < generated.length; index += 1) {
    const fileName = `${stem}-${index + 1}.xlsx`;
    const outputPath = path.join(outputDirectory, fileName);
    await writeFile(outputPath, generated[index].buffer);
    parts.push({
      path: outputPath,
      fileName,
      index: index + 1,
      total,
      dataRows: generated[index].dataRows,
      sizeBytes: generated[index].buffer.length,
    });
  }
  return { sourcePath, split: true, parts };
}
