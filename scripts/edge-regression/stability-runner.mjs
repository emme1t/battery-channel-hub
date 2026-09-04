const FULL_DURATION_MS = 5 * 60_000;
const MEMORY_SAMPLE_INTERVAL_MS = FULL_DURATION_MS / 3;

function terminal(ok, errorCode, message, metrics = {}) {
  return ok
    ? { status: 'PASS', assertions: [{ key: errorCode, ok: true, message }], metrics, error: null }
    : { status: 'FAIL', assertions: [{ key: errorCode, ok: false, message }], metrics, error: { code: errorCode, message } };
}

function normalizedCycle(result, fallbackCode) {
  if (result?.ok === true) return { ok: true, latencyMs: Number(result.latencyMs || 0), details: result };
  return {
    ok: false,
    latencyMs: Number(result?.latencyMs || 0),
    details: result,
    error: result?.error || { code: fallbackCode, message: `${fallbackCode} failed` }
  };
}

function memoryAssessment(samples, growthLimitBytes, absoluteLimitBytes) {
  const values = samples.map(sample => Number(sample.aggregateRss || 0));
  const peak = Math.max(0, ...values);
  const growth = values.length > 1 ? values.at(-1) - values[0] : 0;
  const consistentlyIncreasing = values.length >= 2 && values.slice(1).every((value, index) => value > values[index]);
  const ok = peak <= absoluteLimitBytes && !(consistentlyIncreasing && growth > growthLimitBytes);
  return { ok, peak, growth, consistentlyIncreasing };
}

export async function runStability({
  mode,
  clock = { now: () => performance.now(), sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) },
  runListCycle,
  runStateCycle,
  restartCheck,
  sampleProcessMemory,
  memoryGrowthLimitBytes = 256 * 1024 * 1024,
  memoryAbsoluteLimitBytes = 1.5 * 1024 * 1024 * 1024
}) {
  if (!['quick', 'full'].includes(mode)) throw new TypeError('mode must be quick or full');
  for (const [name, value] of Object.entries({ runListCycle, runStateCycle, restartCheck, sampleProcessMemory })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  const started = clock.now();
  const memorySamples = [{ elapsedMs: 0, ...(await sampleProcessMemory()) }];
  const listResults = [];
  const stateResults = [];

  if (mode === 'quick') {
    for (let index = 0; index < 3; index += 1) listResults.push(normalizedCycle(await runListCycle(index), 'STABILITY_LIST_CYCLE_FAILED'));
    for (let index = 0; index < 2; index += 1) stateResults.push(normalizedCycle(await runStateCycle(index), 'STABILITY_STATE_CYCLE_FAILED'));
  } else {
    const cycleInterval = FULL_DURATION_MS / 50;
    let nextMemoryMark = MEMORY_SAMPLE_INTERVAL_MS;
    for (let index = 0; index < 50; index += 1) {
      listResults.push(normalizedCycle(await runListCycle(index), 'STABILITY_LIST_CYCLE_FAILED'));
      if (index % 5 === 0) stateResults.push(normalizedCycle(await runStateCycle(index / 5), 'STABILITY_STATE_CYCLE_FAILED'));
      const targetElapsed = Math.round((index + 1) * cycleInterval);
      const beforeSleep = clock.now();
      await clock.sleep(Math.max(0, started + targetElapsed - beforeSleep));
      const elapsed = clock.now() - started;
      while (elapsed >= nextMemoryMark && nextMemoryMark <= FULL_DURATION_MS) {
        memorySamples.push({ elapsedMs: nextMemoryMark, ...(await sampleProcessMemory()) });
        nextMemoryMark += MEMORY_SAMPLE_INTERVAL_MS;
      }
      if (clock.now() === beforeSleep && targetElapsed > elapsed) break;
    }
  }

  const elapsedMs = Math.max(0, clock.now() - started);
  if (mode === 'quick' || memorySamples.at(-1)?.elapsedMs !== elapsedMs) {
    memorySamples.push({ elapsedMs, ...(await sampleProcessMemory()) });
  }
  const restart = await restartCheck();
  const memory = memoryAssessment(memorySamples, memoryGrowthLimitBytes, memoryAbsoluteLimitBytes);
  const listOk = listResults.length >= (mode === 'full' ? 50 : 3) && listResults.every(item => item.ok);
  const stateOk = stateResults.length >= (mode === 'full' ? 10 : 2) && stateResults.every(item => item.ok);
  const durationOk = mode === 'quick' || elapsedMs >= FULL_DURATION_MS;
  const restartOk = restart?.ok === true;

  const scenarios = {
    'ST-01': terminal(durationOk, durationOk ? 'continuous-runtime' : 'STABILITY_DURATION_SHORT', mode === 'quick' ? '快速模式为缩短覆盖，不声明 5 分钟稳定性' : `连续运行 ${Math.round(elapsedMs / 1000)} 秒`, { elapsedMs, requiredMs: FULL_DURATION_MS }),
    'ST-02': terminal(listOk, listOk ? 'list-cycles' : 'STABILITY_LIST_CYCLE_FAILED', `列表循环 ${listResults.length} 次`, { cycles: listResults.length, results: listResults }),
    'ST-03': terminal(stateOk, stateOk ? 'state-cycles' : 'STABILITY_STATE_CYCLE_FAILED', `状态循环 ${stateResults.length} 次`, { cycles: stateResults.length, results: stateResults }),
    'ST-04': terminal(memory.ok, memory.ok ? 'memory-trend' : 'STABILITY_MEMORY_GROWTH', `内存峰值 ${memory.peak}，净增长 ${memory.growth}`, { ...memory, samples: memorySamples }),
    'ST-05': terminal(restartOk, restartOk ? 'final-restart' : (restart?.error?.code || 'STABILITY_RESTART_FAILED'), restartOk ? '最终重启与重读一致' : (restart?.error?.message || '最终重启检查失败'), { restart })
  };
  const allPass = Object.values(scenarios).every(item => item.status === 'PASS');
  return {
    coverage: mode === 'quick' ? 'FAST_COVERAGE' : 'FULL_5_MINUTES',
    fullGateSatisfied: mode === 'full' && allPass && elapsedMs >= FULL_DURATION_MS,
    scenarios,
    metrics: {
      elapsedMs,
      listCycles: listResults.length,
      stateCycles: stateResults.length,
      memorySamples: memorySamples.length
    }
  };
}

export { FULL_DURATION_MS };
