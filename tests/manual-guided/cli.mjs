import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readManualGuidedReplay, verifyManualGuidedReplayBindings } from './report-writer.mjs';
import { replayManualGuidedReport, runManualGuidedShell } from './full-shell.mjs';

export function resolveCliDependencies(dependencies = {}) {
  return {
    ...dependencies,
    run: dependencies.run || runManualGuidedShell,
    replay: dependencies.replay || replayManualGuidedReport
  };
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length % 2 !== 0) throw new TypeError('arguments must be option/value pairs');
  const values = {};
  const allowed = new Set(['--mode', '--executable', '--manual', '--styles-root', '--report']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.has(key)) throw new TypeError(`unknown argument: ${key}`);
    if (Object.hasOwn(values, key)) throw new TypeError(`duplicate argument: ${key}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`missing value for ${key}`);
    values[key] = value;
  }
  if (!['quick', 'full', 'replay'].includes(values['--mode'])) throw new TypeError('unsupported mode');
  return values;
}

async function existingAbsolute(target, kind) {
  if (!path.isAbsolute(target || '')) throw new TypeError(`${kind} path must be absolute`);
  const details = await stat(target);
  if (kind === 'styles root' ? !details.isDirectory() : !details.isFile()) throw new TypeError(`${kind} has wrong type`);
  return path.resolve(target);
}

function exitFor(result) {
  if (result?.protection?.ok !== true || result?.cleanup?.verified !== true) return 3;
  return result?.status === 'passed' ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const resolvedDependencies = resolveCliDependencies(dependencies);
  try {
    const args = parseArgs(argv);
    const mode = args['--mode'];
    if (mode === 'replay') {
      if (Object.keys(args).some(key => !['--mode', '--report'].includes(key))) throw new TypeError('replay accepts only report');
      const reportPath = await existingAbsolute(args['--report'], 'report');
      const readReplay = resolvedDependencies.readReplay || (async reportPath => {
        const report = await readManualGuidedReplay(reportPath);
        await verifyManualGuidedReplayBindings(report);
        return report;
      });
      const replay = resolvedDependencies.replay;
      return exitFor(await replay(await readReplay(reportPath)));
    }
    if (Object.keys(args).some(key => !['--mode', '--executable', '--manual', '--styles-root'].includes(key))) {
      throw new TypeError('quick/full arguments are invalid');
    }
    const executablePath = await existingAbsolute(args['--executable'], 'executable');
    const manualPath = await existingAbsolute(args['--manual'], 'manual');
    const stylesRoot = await existingAbsolute(args['--styles-root'], 'styles root');
    return exitFor(await resolvedDependencies.run({ mode, executablePath, manualPath, stylesRoot }));
  } catch (error) {
    if (resolvedDependencies.onError) resolvedDependencies.onError(error);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), {
    onError(error) { console.error(error?.message || String(error)); }
  });
}
