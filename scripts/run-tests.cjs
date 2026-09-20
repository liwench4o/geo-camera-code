const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function discoverTests(directory, base = directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return discoverTests(filename, base);
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [path.relative(base, filename)] : [];
    })
    .sort();
}

function runTests() {
  const root = path.resolve(__dirname, '..');
  const sources = discoverTests(path.join(root, 'src'));
  if (sources.length === 0) throw new Error('No source tests were discovered.');
  if (process.argv.includes('--list')) {
    console.log(sources.map((file) => path.join('src', file)).join('\n'));
    return 0;
  }
  const compiled = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.test.json'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) return compiled.status ?? 1;
  let failures = 0;
  for (const source of sources) {
    // Discover from source, never from cached output: removed tests stay removed.
    const output = path.join(root, '.cache', 'camera-tests', 'src', source.replace(/\.ts$/, '.js'));
    const result = spawnSync(process.execPath, [output], { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      failures += 1;
      console.error(`FAIL ${path.join('src', source)}`);
      if (result.error) console.error(result.error.message);
    }
  }
  console.log(`${sources.length} test files executed; ${failures} failed.`);
  return failures === 0 ? 0 : 1;
}

module.exports = { discoverTests, runTests };
if (require.main === module) process.exitCode = runTests();
