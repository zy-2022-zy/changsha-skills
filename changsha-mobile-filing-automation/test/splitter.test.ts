import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import { splitWorkbookIfNeeded } from '../src/splitter.js';

const sourceWorkbook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'filing-validation-rules.xlsx');

function rows(filePath: string, sheetName: string): unknown[][] {
  const workbook = XLSX.readFile(filePath, { raw: true });
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null, raw: true }) as unknown[][];
}

test('splitter keeps the six template rows, auxiliary sheet and row limits', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'filing-split-'));
  const sourceMainRows = rows(sourceWorkbook, '真实发送端口报送模板');
  const sourceLocationRows = rows(sourceWorkbook, '省份地市名称');
  const result = await splitWorkbookIfNeeded(sourceWorkbook, { maxRows: 5, outputRoot });

  assert.equal(result.split, true);
  assert.equal(result.parts.length, 3);
  assert.deepEqual(result.parts.map((part) => part.fileName), [1, 2, 3].map((index) => `filing-validation-rules-${index}.xlsx`));
  const firstBuffers = await Promise.all(result.parts.map((part) => readFile(part.path)));
  const repeated = await splitWorkbookIfNeeded(sourceWorkbook, { maxRows: 5, outputRoot });
  assert.deepEqual(await Promise.all(repeated.parts.map((part) => readFile(part.path))), firstBuffers);
  for (const part of result.parts) {
    assert.equal(path.extname(part.path), '.xlsx');
    assert.ok(part.dataRows <= 5);
    assert.equal((await stat(part.path)).size, part.sizeBytes);
    const workbook = XLSX.readFile(part.path, { raw: true });
    assert.ok(workbook.SheetNames.includes('省份地市名称'));
    const partMainRows = XLSX.utils.sheet_to_json(workbook.Sheets['真实发送端口报送模板'], { header: 1, defval: null, raw: true }) as unknown[][];
    assert.deepEqual(partMainRows.slice(0, 6), sourceMainRows.slice(0, 6));
    assert.deepEqual(rows(part.path, '省份地市名称'), sourceLocationRows);
    assert.equal(partMainRows.slice(6).filter((row) => row.some((value) => value !== null && value !== '')).length, part.dataRows);
  }
});

test('splitter keeps only images belonging to each data slice and remaps their row anchors', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'filing-split-images-'));
  const sourcePath = path.join(temporary, 'with-images.xlsx');
  const zip = await JSZip.loadAsync(await readFile(sourceWorkbook));
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  zip.file('xl/worksheets/sheet1.xml', sheetXml.replace('</worksheet>', '<drawing r:id="rIdDrawingTest"/></worksheet>'));
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawingTest" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
  zip.file('xl/drawings/drawing1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>12</xdr:col><xdr:row>6</xdr:row></xdr:from><xdr:to><xdr:col>13</xdr:col><xdr:row>7</xdr:row></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="rIdImage1"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor><xdr:twoCellAnchor><xdr:from><xdr:col>12</xdr:col><xdr:row>13</xdr:row></xdr:from><xdr:to><xdr:col>13</xdr:col><xdr:row>14</xdr:row></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="rIdImage2"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>');
  zip.file('xl/drawings/_rels/drawing1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/><Relationship Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/></Relationships>');
  zip.file('xl/media/image1.png', Buffer.from('image-one'));
  zip.file('xl/media/image2.png', Buffer.from('image-two'));
  await writeFile(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const result = await splitWorkbookIfNeeded(sourcePath, { maxRows: 5, outputRoot: path.join(temporary, 'output') });
  const first = await JSZip.loadAsync(await readFile(result.parts[0].path));
  const second = await JSZip.loadAsync(await readFile(result.parts[1].path));
  assert.ok(first.file('xl/media/image1.png'));
  assert.equal(first.file('xl/media/image2.png'), null);
  assert.equal(second.file('xl/media/image1.png'), null);
  assert.ok(second.file('xl/media/image2.png'));
  const secondDrawing = await second.file('xl/drawings/drawing1.xml')!.async('string');
  assert.match(secondDrawing, /<xdr:row>8<\/xdr:row>/);
  assert.doesNotMatch(secondDrawing, /rIdImage1/);
});

test('splitter removes unused WPS cell images but preserves referenced resources', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'filing-wps-'));
  const sourcePath = path.join(temporary, 'wps.xlsx');
  const zip = await JSZip.loadAsync(await readFile(sourceWorkbook));
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  zip.file('xl/worksheets/sheet1.xml', xml.replace(/(<row\b[^>]*\br="7"[^>]*>)/, '$1<c r="AO7"><f>DISPIMG(&quot;ID_KEEP&quot;,1)</f></c>'));
  zip.file('xl/cellimages.xml', '<etc:cellImages><etc:cellImage><xdr:cNvPr name="ID_KEEP"/><a:blip r:embed="rId1"/></etc:cellImage><etc:cellImage><xdr:cNvPr name="ID_UNUSED"/><a:blip r:embed="rId2"/></etc:cellImage></etc:cellImages>');
  zip.file('xl/_rels/cellimages.xml.rels', '<Relationships><Relationship Id="rId1" Target="media/keep.png"/><Relationship Id="rId2" Target="media/unused.png"/></Relationships>');
  zip.file('xl/media/keep.png', 'keep');
  zip.file('xl/media/unused.png', 'unused');
  await writeFile(sourcePath, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await splitWorkbookIfNeeded(sourcePath, { maxRows: 5 });
  const first = await JSZip.loadAsync(await readFile(result.parts[0].path));
  assert.ok(first.file('xl/media/keep.png'));
  assert.equal(first.file('xl/media/unused.png'), null);
  assert.doesNotMatch(await first.file('xl/cellimages.xml')!.async('string'), /ID_UNUSED/);
  const second = await JSZip.loadAsync(await readFile(result.parts[1].path));
  assert.equal(second.file('xl/media/keep.png'), null);
});

test('splitter leaves a compliant workbook unchanged', async () => {
  const result = await splitWorkbookIfNeeded(sourceWorkbook);
  assert.equal(result.split, false);
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].path, sourceWorkbook);
});

test('splitter enforces the generated file byte limit after removing unused shared strings', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'filing-split-size-'));
  const sourcePath = path.join(temporary, 'large-shared-strings.xlsx');
  const zip = await JSZip.loadAsync(await readFile(sourceWorkbook));
  let sharedStrings = await zip.file('xl/sharedStrings.xml')!.async('string');
  let sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  const initialCount = [...sharedStrings.matchAll(/<si\b[^>]*>[\s\S]*?<\/si>/g)].length;
  const added: string[] = [];
  for (let index = 0; index < 15; index += 1) {
    added.push(`<si><t>${randomBytes(12_000).toString('base64')}</t></si>`);
    const excelRow = 7 + index;
    const cellPattern = new RegExp(`(<c\\b[^>]*\\br=["']A${excelRow}["'][^>]*>[\\s\\S]*?<v>)(\\d+)(<\\/v>[\\s\\S]*?<\\/c>)`);
    sheetXml = sheetXml.replace(cellPattern, `$1${initialCount + index}$3`);
  }
  sharedStrings = sharedStrings.replace('</sst>', `${added.join('')}</sst>`);
  zip.file('xl/sharedStrings.xml', sharedStrings);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  await writeFile(sourcePath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

  const singleRow = await splitWorkbookIfNeeded(sourcePath, { maxRows: 1, maxBytes: 10 * 1024 * 1024, outputRoot: path.join(temporary, 'single') });
  const maxSingleRowSize = Math.max(...singleRow.parts.map((part) => part.sizeBytes));
  const byteLimit = maxSingleRowSize + 2_000;
  assert.ok((await stat(sourcePath)).size > byteLimit);

  const result = await splitWorkbookIfNeeded(sourcePath, { maxRows: 15, maxBytes: byteLimit, outputRoot: path.join(temporary, 'limited') });
  assert.ok(result.parts.length > 1);
  assert.equal(result.parts.reduce((sum, part) => sum + part.dataRows, 0), 15);
  assert.ok(result.parts.every((part) => part.sizeBytes <= byteLimit));
});
