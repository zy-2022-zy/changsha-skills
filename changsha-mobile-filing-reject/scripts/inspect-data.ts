/** 统计下载文件里的驳回原因分布，为 SEDP 的“备注”列取值提供依据。 */
import XLSX from 'xlsx';

const file = process.argv[2];
if (!file) { console.log('用法：inspect-data <xlsx>'); process.exit(1); }

const book = XLSX.readFile(file);
const name = book.SheetNames[0];
const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, defval: '', blankrows: true });
console.log('表头:', JSON.stringify(rows[0]));

const header = rows[0].map(v => String(v).trim());
const portIndex = header.indexOf('端口');
const reasonIndex = header.indexOf('驳回原因');
const typeIndex = header.indexOf('驳回类型');
console.log(`列索引 端口=${portIndex} 驳回原因=${reasonIndex} 驳回类型=${typeIndex}`);

const data = rows.slice(1).filter(r => r.some(v => String(v).trim() !== ''));
console.log(`数据行数: ${data.length}`);

const reasons = new Map<string, number>();
for (const row of data) {
  const reason = String(row[reasonIndex] ?? '').trim();
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}
console.log(`\n驳回原因分布（${reasons.size} 种）:`);
for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}\t${reason}`);
}

const ports = data.map(r => String(r[portIndex] ?? '').trim());
console.log(`\n端口号: 总数 ${ports.length}, 去重 ${new Set(ports).size}`);
console.log(`端口号长度分布: ${[...new Set(ports.map(p => p.length))].sort((a, b) => a - b).join(', ')}`);
console.log(`样例端口: ${ports.slice(0, 5).join(', ')}`);
console.log(`是否全部为数字: ${ports.every(p => /^\d+$/.test(p))}`);
