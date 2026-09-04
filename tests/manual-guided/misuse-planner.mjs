const SCENARIO_IDS = new Set(['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07']);

const ALLOWED_VISIBLE_MISUSE = new Set([
  'reserve', 'startImmediately', 'startStorage', 'doubleClick', 'editDevice',
  'search', 'paginate', 'navigate', 'finishRunning'
]);

const SCENARIO_STEPS = Object.freeze({
  F01: Object.freeze([
    Object.freeze({
      purpose: 'missing-selection',
      candidates: Object.freeze(['reserve', 'startImmediately']),
      params: Object.freeze({ omit: 'channel', expected: 'rejected' })
    })
  ]),
  F02: Object.freeze([
    Object.freeze({
      purpose: 'double-submit',
      candidates: Object.freeze(['doubleClick']),
      params: Object.freeze({ target: 'submit', expectedActiveRecords: 1 })
    })
  ]),
  F03: Object.freeze([
    Object.freeze({
      purpose: 'wrong-time',
      candidates: Object.freeze(['reserve', 'startImmediately']),
      params: Object.freeze({ timeOrder: 'endBeforeStart', expected: 'rejected' })
    })
  ]),
  F04: Object.freeze([
    Object.freeze({
      purpose: 'active-resource-edit',
      candidates: Object.freeze(['editDevice']),
      params: Object.freeze({ resourceState: 'active', expected: 'rejected' })
    })
  ]),
  F05: Object.freeze([
    Object.freeze({
      purpose: 'hostile-visible-text',
      candidates: Object.freeze(['search']),
      params: Object.freeze({
        values: Object.freeze(['超长中文引号“测试”', '*', '?', '第一行\n第二行', 'spaces-only:   '])
      })
    })
  ]),
  F06: Object.freeze([
    Object.freeze({ purpose: 'rapid-navigation', candidates: Object.freeze(['navigate']), params: Object.freeze({ repeat: 4 }) }),
    Object.freeze({ purpose: 'rapid-search', candidates: Object.freeze(['search']), params: Object.freeze({ value: '*?虚构' }) }),
    Object.freeze({ purpose: 'rapid-pagination', candidates: Object.freeze(['paginate']), params: Object.freeze({ direction: 'next-previous' }) })
  ]),
  F07: Object.freeze([
    Object.freeze({
      purpose: 'stale-detail',
      candidates: Object.freeze(['finishRunning']),
      params: Object.freeze({ detailVersion: 'stale', expected: 'rejected-or-current-state-preserved' })
    })
  ])
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createSeededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function visibleCandidates(step, available) {
  return step.candidates.filter(type => ALLOWED_VISIBLE_MISUSE.has(type) && available.has(type));
}

export function planHumanMisuse({ scenarioId, seed, visibleState } = {}) {
  if (!SCENARIO_IDS.has(scenarioId)) throw new TypeError(`unknown misuse scenario: ${String(scenarioId)}`);
  if (!Number.isSafeInteger(seed)) throw new TypeError('misuse seed must be a safe integer');
  if (!visibleState || !Array.isArray(visibleState.availableActions)) {
    throw new TypeError('visibleState.availableActions must be an array');
  }

  const available = new Set(visibleState.availableActions);
  const random = createSeededRandom(seed);
  const candidateSets = [];
  const actions = [];

  for (const [index, step] of SCENARIO_STEPS[scenarioId].entries()) {
    const candidates = visibleCandidates(step, available);
    if (candidates.length === 0) throw new Error('no allowed visible misuse candidate');
    const selectedIndex = Math.floor(random() * candidates.length);
    const selected = candidates[selectedIndex];
    candidateSets.push({
      step: index + 1,
      purpose: step.purpose,
      visibleCandidates: [...candidates],
      selected
    });
    actions.push({
      id: `${scenarioId}-${String(index + 1).padStart(2, '0')}-${selected}`,
      type: selected,
      purpose: step.purpose,
      params: step.params
    });
  }

  return deepFreeze({ scenarioId, seed, candidateSets, actions });
}

export function replayHumanMisuse({ plan } = {}) {
  if (!plan || !SCENARIO_IDS.has(plan.scenarioId) || !Array.isArray(plan.actions)) {
    throw new TypeError('recorded misuse plan is required');
  }
  return Object.freeze([...plan.actions]);
}
