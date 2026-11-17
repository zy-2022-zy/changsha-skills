import { parseArgs } from 'node:util';
import { loadOptionalEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { dateRange, dateFolder } from './dates.js';
import path from 'node:path';
import { inspectWorkbook } from './workbook.js';
import { generateSedpWorkbook } from './sedp.js';
import { run } from './runner.js';
import { RejectPortal } from './portal.js';

const help = `长沙移动系统集团驳回数据Skill（普通端口、视频短信）
  scripts\\run.cmd export [--date YYYY-MM-DD | --start YYYY-MM-DD --end YYYY-MM-DD]
  scripts\\run.cmd export --date YYYY-MM-DD --execute
  scripts\\run.cmd results --batch-id <完整批次号> [--date YYYY-MM-DD]
  scripts\\run.cmd results --date YYYY-MM-DD
  scripts\\run.cmd inspect --file <已下载.xlsx> [--header-row 1]
  scripts\\run.cmd sedp --file <已下载.xlsx> [--output <SEDP.xlsx>]
不带 --execute 的 export 仅打印计划，不打开浏览器。
results 只续查、下载已有任务。默认日期为北京时间前一个周一至周五，节假日/调休请指定日期。
下载完成后自动生成 SEDP 上传格式（签名留空，报备结果固定为失败），--no-sedp 可跳过。
EXE 安装版内置运行环境，直接使用 scripts\\run.cmd。配置 BROWSER_CDP_URL 可连接云浏览器；留空时使用本机 Chrome 或 Edge。
开发源码首次使用才需要 pnpm install；本地 Chromium 模式需 pnpm exec playwright install chromium。\n登录分阶段执行：login-start 准备页面并返回需要员工处理的验证题；login-verify 填入员工答案并请求短信；login-submit 从标准输入读取短信验证码。验证码不写入日志或配置文件。`;

async function main(): Promise<void> {
  await loadOptionalEnvFile();
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift(); // pnpm 11 保留 start 后的分隔符，兼容旧版 pnpm。
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    date: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
    'batch-id': { type: 'string' }, execute: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    file: { type: 'string' }, 'header-row': { type: 'string' }, output: { type: 'string' },
    'no-sedp': { type: 'boolean' }, answer: { type: 'string' }, 'sms-code-stdin': { type: 'boolean' },
  } });
  if (values.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1) throw new Error('只接受一个命令。');
  const command = positionals[0];
  const allowed: Record<string, string[]> = {
    export: ['date', 'start', 'end', 'execute', 'header-row', 'no-sedp'],
    results: ['date', 'start', 'end', 'batch-id', 'header-row', 'no-sedp'],
    inspect: ['file', 'header-row'], sedp: ['file', 'output', 'header-row'],\n    'login-start': [], 'login-verify': ['answer'], 'login-submit': ['sms-code-stdin'],
  };
  if (!allowed[command]) throw new Error(`未知命令：${command}`);
  for (const key of Object.keys(values)) if (!allowed[command].includes(key)) throw new Error(`${command} 不支持 --${key}。`);
  if (command === 'login-start' || command === 'login-verify' || command === 'login-submit') {\n    const config = loadConfig();\n    const portal = await RejectPortal.launch(config);\n    try {\n      if (command === 'login-start') {\n        console.log(JSON.stringify(await portal.beginLogin(), null, 2));\n      } else if (command === 'login-verify') {\n        console.log(JSON.stringify(await portal.requestSmsCode(values.answer), null, 2));\n      } else {\n        if (!values['sms-code-stdin']) throw new Error('login-submit 必须使用 --sms-code-stdin，从标准输入安全读取短信验证码。');\n        let code = '';\n        for await (const chunk of process.stdin) code += String(chunk);\n        code = code.trim();\n        if (!code) throw new Error('标准输入中没有收到短信验证码。');\n        await portal.submitSmsCode(code);\n        console.log(JSON.stringify({ status: 'authenticated', message: '登录成功。' }, null, 2));\n      }\n    } finally { await portal.close(); }\n    return;\n  }\n  const headerRow = values['header-row'] === undefined ? undefined : Number(values['header-row']);
  if (headerRow !== undefined && (!Number.isSafeInteger(headerRow) || headerRow < 1)) throw new Error('--header-row 必须是正整数。');
  if (command === 'inspect') {
    if (!values.file) throw new Error('inspect 需要 --file。');
    console.log(JSON.stringify(await inspectWorkbook(values.file, headerRow), null, 2)); return;
  }
  if (command === 'sedp') {
    if (!values.file) throw new Error('sedp 需要 --file。');
    const output = values.output ?? path.join(path.dirname(path.resolve(values.file)),
      `${path.basename(values.file, path.extname(values.file))}-SEDP需要上传的文档.xlsx`);
    console.log(JSON.stringify(await generateSedpWorkbook(values.file, output, headerRow), null, 2)); return;
  }
  const batchId = values['batch-id'];
  if (batchId !== undefined && !/^\d{12,}$/.test(batchId)) throw new Error('批次号必须是完整数字字符串，至少 12 位。');
  const explicitRange = values.date !== undefined || values.start !== undefined || values.end !== undefined;
  const range = command === 'export' || explicitRange ? dateRange({ date: values.date, start: values.start, end: values.end }) : undefined;
  if (command === 'results' && !range && !batchId) throw new Error('results 需要 --batch-id 或原日期范围。');
  const config = loadConfig();
  if (command === 'export' && !values.execute) {
    console.log(JSON.stringify({ mode: 'plan', range, rejectType: '集团驳回', taskName: '驳回端口导出',
      navigation: ['端口上报管理', '驳回端口查询'],
      downloadDir: path.join(config.downloadDir, dateFolder(range)), countBasis: '实际下载 XLSX 的非空数据行',
      sedp: values['no-sedp'] ? '跳过' : { file: '<下载文件名>-SEDP需要上传的文档.xlsx',
        header: ['子端口', '签名', '报备结果', '备注'], signature: '留空', result: '失败', remark: '集团驳回' },
    }, null, 2)); return;
  }
  const result = await run(config, { range, batchId, resultsOnly: command === 'results', headerRow, noSedp: values['no-sedp'] });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
