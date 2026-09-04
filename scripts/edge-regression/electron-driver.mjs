import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function safeName(value) {
  return String(value || 'electron-smoke').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'electron-smoke';
}

async function readScripts(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  return manifest.scripts || {};
}

function executeNpmScript({ projectRoot, script, timeoutMs, maxOutputBytes }) {
  const windows = process.platform === 'win32';
  const executable = windows ? process.env.ComSpec : 'npm';
  const args = windows
    ? ['/d', '/s', '/c', `npm.cmd run --silent ${script}`]
    : ['run', '--silent', script];
  const childEnvironment = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete childEnvironment.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
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

export function createElectronEvidenceDriver({
  projectRoot,
  runRoot,
  timeoutMs = 180_000,
  maxOutputBytes = 20 * 1024 * 1024
}) {
  if (!projectRoot || !runRoot) throw new TypeError('projectRoot and runRoot are required');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const evidenceRoot = path.join(path.resolve(runRoot), 'artifacts', 'electron');
  const cache = new Map();

  return Object.freeze({
    async runSmoke({ key, script }) {
      if (!key || !script || !/^[A-Za-z0-9:_-]+$/.test(script)) {
        throw new TypeError('electron evidence key and safe package script are required');
      }
      if (cache.has(script)) return structuredClone(await cache.get(script));
      const operation = (async () => {
        const scripts = await readScripts(resolvedProjectRoot);
        if (typeof scripts[script] !== 'string') {
          return {
            ok: false,
            key,
            script,
            evidencePath: null,
            error: { code: 'ELECTRON_SCRIPT_MISSING', message: `package.json 未声明脚本 ${script}` }
          };
        }
        await mkdir(evidenceRoot, { recursive: true });
        let execution;
        try {
          execution = await executeNpmScript({
            projectRoot: resolvedProjectRoot,
            script,
            timeoutMs,
            maxOutputBytes
          });
        } catch (error) {
          return {
            ok: false,
            key,
            script,
            evidencePath: null,
            error: {
              code: error.code === 'ENOENT' ? 'ENVIRONMENT_UNAVAILABLE' : 'ELECTRON_SMOKE_LAUNCH_FAILED',
              message: error.message
            }
          };
        }
        const evidencePath = path.join(evidenceRoot, `${safeName(key)}.log`);
        const output = [
          `# npm run ${script}`,
          `# exitCode=${execution.exitCode} signal=${execution.signal || ''}`,
          execution.stdout,
          execution.stderr ? `# STDERR\n${execution.stderr}` : ''
        ].join('\n');
        await writeFile(evidencePath, output, 'utf8');
        let error = null;
        if (execution.timedOut) error = { code: 'ELECTRON_SMOKE_TIMEOUT', message: `Electron 冒烟超过 ${timeoutMs} ms` };
        else if (execution.overflow) error = { code: 'ELECTRON_SMOKE_OUTPUT_LIMIT', message: 'Electron 冒烟输出超过安全上限' };
        else if (execution.exitCode !== 0) error = { code: 'ELECTRON_SMOKE_FAILED', message: `Electron 冒烟退出码 ${execution.exitCode}` };
        return {
          ok: error === null,
          key,
          script,
          exitCode: execution.exitCode,
          signal: execution.signal,
          summary: { outputBytes: Buffer.byteLength(output), exitCode: execution.exitCode },
          evidencePath,
          error
        };
      })();
      cache.set(script, operation);
      return structuredClone(await operation);
    }
  });
}
