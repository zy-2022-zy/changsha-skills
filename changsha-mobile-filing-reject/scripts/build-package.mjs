import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const payload = path.join(root, 'build', 'workbuddy-payload');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows with an x64 Node.js runtime.');
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20+ is required.');

// Delete only our generated payload; reject junctions/symlinks outside the repository.
fs.mkdirSync(path.dirname(payload), { recursive: true });
if (path.resolve(fs.realpathSync(path.dirname(payload))) !== path.join(fs.realpathSync(root), 'build')) {
  throw new Error('The build directory must be inside this repository.');
}
if (fs.existsSync(payload)) {
  if (fs.lstatSync(payload).isSymbolicLink() || !fs.existsSync(path.join(payload, '.generated-payload'))) {
    throw new Error('Refusing to replace a directory not created by this build.');
  }
  fs.rmSync(payload, { recursive: true, force: true });
}
fs.mkdirSync(payload);
fs.writeFileSync(path.join(payload, '.generated-payload'), `${pkg.name}\n`);

function copy(relative) {
  const dest = path.join(payload, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(root, relative), dest, { recursive: true, dereference: true });
}

// Explicit allowlist: never package .env, sessions, reports, downloads or diagnostics.
for (const relative of ['SKILL.md', '.env.example', 'agents', 'references', 'src', 'scripts/run.cmd', 'scripts/run-export.ps1']) copy(relative);
fs.copyFileSync(path.join(root, 'packaging', 'installed-usage.txt'), path.join(payload, '使用说明.txt'));
fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, private: true, type: 'module',
  description: pkg.description, engines: pkg.engines, dependencies: pkg.dependencies,
}, null, 2) + '\n');

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' });

// pnpm uses symlinks. Resolve and copy the production dependency graph as ordinary
// directories so the installed program works without pnpm, npm, or a global Node.js.
const dependencies = new Map();
function copyDependency(name, from) {
  const resolver = createRequire(path.join(from, 'package.json'));
  const manifest = resolver.resolve(`${name}/package.json`);
  const directory = fs.realpathSync(path.dirname(manifest));
  const dependency = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (dependencies.has(name)) {
    if (dependencies.get(name) !== dependency.version) throw new Error(`Conflicting runtime dependency versions: ${name}`);
    return;
  }
  dependencies.set(name, dependency.version);
  const destination = path.join(payload, 'node_modules', name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(directory, destination, { recursive: true, dereference: true });
  for (const child of Object.keys(dependency.dependencies ?? {})) copyDependency(child, directory);
}
for (const name of Object.keys(pkg.dependencies)) copyDependency(name, root);

fs.mkdirSync(path.join(payload, 'runtime'));
fs.copyFileSync(process.execPath, path.join(payload, 'runtime', 'node.exe'));
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
if (!fs.existsSync(nodeLicense)) throw new Error('The Node.js distribution LICENSE file is required.');
fs.copyFileSync(nodeLicense, path.join(payload, 'runtime', 'LICENSE.txt'));

const files = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in payload: ${absolute}`);
    if (entry.isDirectory()) { scan(absolute); continue; }
    const relative = path.relative(payload, absolute).replaceAll('\\', '/');
    if (relative === '.generated-payload') continue;
    if (['.env', '.runtime', 'reports', 'downloads', '.docx-review'].includes(relative.split('/')[0])) {
      throw new Error(`Private runtime data in payload: ${relative}`);
    }
    const bytes = fs.readFileSync(absolute);
    files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
scan(payload);
fs.writeFileSync(path.join(payload, 'package-manifest.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, node: process.version,
  platform: 'win32-x64', dependencies: Object.fromEntries(dependencies), files,
}, null, 2) + '\n');
console.log(JSON.stringify({ payload, version: pkg.version, files: files.length,
  bytes: files.reduce((sum, file) => sum + file.size, 0), dependencies: Object.fromEntries(dependencies) }, null, 2));
