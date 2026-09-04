export function createSeededRandom(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError('seed must be a non-negative safe integer');
  let cursor = seed >>> 0;
  const next = () => {
    cursor = (cursor + 0x6D2B79F5) >>> 0;
    let value = cursor;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return Object.freeze({
    next,
    int(min, max) { return min + Math.floor(next() * (max - min + 1)); },
    pick(items) { if (!items.length) throw new TypeError('items required'); return items[Math.floor(next() * items.length)]; },
    weightedPick(items) {
      if (!items.length || items.some(item => !(item.weight > 0))) throw new TypeError('positive weight required');
      const total = items.reduce((sum, item) => sum + item.weight, 0);
      let target = next() * total;
      for (const item of items) { target -= item.weight; if (target < 0) return item.value; }
      return items.at(-1).value;
    },
    state() { return cursor; }
  });
}
