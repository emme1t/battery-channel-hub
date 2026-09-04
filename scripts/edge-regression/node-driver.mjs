import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function safeName(value) {
  return String(value || 'node-suite').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'node-suite';
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseSummary(output) {
  const number = label => Number(output.match(new RegExp(`(?:^|\\n)(?:#|ℹ) ${label} (\\d+)`, 'm'))?.[1] || 0);
  return {
    tests: number('tests'),
    pass: number('pass'),
    fail: number('fail'),
    skipped: number('skipped'),
    cancelled: number('cancelled')
  };
}

function executeNodeTests({ projectRoot, files, namePattern, timeoutMs, maxOutputBytes }) {
  const args = ['--test', '--test-reporter=tap'];
  if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
  args.push(...files.map(file => path.resolve(file)));
  const childEnvironment = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete childEnvironment.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        overflow = true;
        child.kill();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        overflow,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

export function createNodeEvidenceDriver({
  projectRoot,
  runRoot,
  timeoutMs = 120_000,
  maxOutputBytes = 20 * 1024 * 1024
}) {
  if (!projectRoot || !runRoot) throw new TypeError('projectRoot and runRoot are required');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedRunRoot = path.resolve(runRoot);
  const evidenceRoot = path.join(resolvedRunRoot, 'artifacts', 'node');
  const cache = new Map();

  return Object.freeze({
    async runTestSuite({ key, files, namePattern = '' }) {
      if (!key || !Array.isArray(files) || files.length === 0) {
        throw new TypeError('node evidence key and files are required');
      }
      const cacheKey = JSON.stringify({ key, files: files.map(file => path.resolve(file)), namePattern });
      if (cache.has(cacheKey)) return structuredClone(await cache.get(cacheKey));
      const operation = (async () => {
        for (const file of files) {
          if (!within(resolvedProjectRoot, file) && !within(resolvedRunRoot, file)) {
            const error = new Error(`Node test file escapes allowed roots: ${file}`);
            error.code = 'NODE_TEST_PATH_ESCAPE';
            throw error;
          }
        }
        await mkdir(evidenceRoot, { recursive: true });
        const execution = await executeNodeTests({
          projectRoot: resolvedProjectRoot,
          files,
          namePattern,
          timeoutMs,
          maxOutputBytes
        });
        const evidencePath = path.join(evidenceRoot, `${safeName(key)}.tap`);
        const combined = `${execution.stdout}${execution.stderr ? `\n# STDERR\n${execution.stderr}` : ''}`;
        await writeFile(evidencePath, combined, 'utf8');
        const summary = parseSummary(execution.stdout);
        const matchedPattern = !namePattern || [...execution.stdout.matchAll(/^# Subtest: (.+)$/gm)]
          .some(match => new RegExp(namePattern).test(match[1]));
        let error = null;
        if (execution.timedOut) error = { code: 'NODE_TEST_TIMEOUT', message: `Node 测试超过 ${timeoutMs} ms` };
        else if (execution.overflow) error = { code: 'NODE_TEST_OUTPUT_LIMIT', message: 'Node 测试输出超过安全上限' };
        else if (execution.exitCode !== 0 || summary.fail > 0 || summary.cancelled > 0) {
          error = { code: 'NODE_TEST_FAILED', message: `Node 测试退出码 ${execution.exitCode}` };
        } else if (summary.pass < 1 || !matchedPattern) {
          error = { code: 'NODE_EVIDENCE_EMPTY', message: 'Node 测试没有实际执行任何通过项' };
        }
        return {
          ok: error === null,
          key,
          files: files.map(file => path.resolve(file)),
          namePattern,
          exitCode: execution.exitCode,
          signal: execution.signal,
          summary,
          evidencePath,
          error
        };
      })();
      cache.set(cacheKey, operation);
      return structuredClone(await operation);
    }
  });
}
