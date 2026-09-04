const PENDING_STATUS = 'pending';

export function assertQuantity(value) {
  if (!Number.isInteger(value) || value < 1 || value > 999) {
    throw new RangeError('样品数量必须是 1–999 的整数');
  }
  return value;
}

export function sampleId(requestNo, index) {
  if (typeof requestNo !== 'string' || requestNo.trim() === '') {
    throw new TypeError('申请单号不能为空');
  }
  assertQuantity(index);
  return `${requestNo}.${String(index).padStart(3, '0')}`;
}

export function reconcileSamples({
  request,
  samples,
  nextQuantity,
  confirmReduction = false
}) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('缺少申请数据');
  }
  if (!Array.isArray(samples)) {
    throw new TypeError('子样品必须是数组');
  }

  const currentQuantity = assertQuantity(request.quantity);
  const requestedQuantity = assertQuantity(nextQuantity);
  if (samples.length !== currentQuantity) {
    throw new Error('申请数量与当前子样品数量不一致');
  }

  const clonedSamples = structuredClone(samples);
  const result = {
    request: { ...structuredClone(request), quantity: requestedQuantity },
    samples: clonedSamples,
    addedSampleIds: [],
    removedSampleIds: []
  };

  if (requestedQuantity === currentQuantity) {
    return result;
  }

  if (requestedQuantity > currentQuantity) {
    for (let ordinal = currentQuantity + 1; ordinal <= requestedQuantity; ordinal += 1) {
      const id = sampleId(request.requestNo, ordinal);
      result.samples.push({
        id,
        requestNo: request.requestNo,
        ordinal,
        status: PENDING_STATUS,
        channelKey: '',
        start: '',
        end: '',
        hasHistory: false
      });
      result.addedSampleIds.push(id);
    }
    return result;
  }

  if (!confirmReduction) {
    throw new Error('减少样品数量需要二次确认');
  }

  const removed = clonedSamples.slice(requestedQuantity);
  if (removed.some((sample) => sample.status !== PENDING_STATUS || sample.hasHistory === true)) {
    throw new Error('数量减少会触及活动或历史子样品，操作已阻断');
  }

  result.samples = clonedSamples.slice(0, requestedQuantity);
  result.removedSampleIds = removed.map((sample) => sample.id);
  return result;
}
