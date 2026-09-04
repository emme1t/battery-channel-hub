import {
  makeChannel,
  makeRecord,
  makeRequest,
  makeSample,
  makeState
} from './state-fixtures.mjs';

export function makeProductionScaleState({
  requestCount = 100,
  channelCount = 529,
  auditCount = 2000
} = {}) {
  const requests = Array.from({ length: requestCount }, (_, index) => {
    const ordinal = index + 1;
    return makeRequest({
      requestNo: `R-${String(ordinal).padStart(4, '0')}`,
      project: `生产项目 ${ordinal}`,
      quantity: ordinal === 1 ? 999 : (ordinal % 20) + 1
    });
  });
  const samples = requests.flatMap((request) =>
    Array.from({ length: request.quantity }, (_, index) =>
      makeSample({
        id: `${request.requestNo}.${String(index + 1).padStart(3, '0')}`,
        requestNo: request.requestNo,
        ordinal: index + 1
      })
    )
  );
  const channels = Array.from({ length: channelCount }, (_, index) => {
    const ordinal = index + 1;
    const deviceOrdinal = Math.floor(index / 24) + 1;
    return makeChannel({
      key: `device-${String(deviceOrdinal).padStart(2, '0')}|${String(ordinal).padStart(3, '0')}`,
      deviceId: `device-${String(deviceOrdinal).padStart(2, '0')}`,
      deviceName: `生产设备 ${deviceOrdinal}`,
      name: String(ordinal).padStart(3, '0')
    });
  });
  const records = channels.slice(0, Math.min(50, channels.length)).map((channel, index) =>
    makeRecord({
      id: `record-${String(index + 1).padStart(4, '0')}`,
      requestNo: requests[index % requests.length]?.requestNo ?? 'R-0001',
      sampleId: samples[index % samples.length]?.id ?? 'R-0001.001',
      channelKey: channel.key,
      status: 'completed',
      actualEnd: '2026-08-20T12:00:00-07:00'
    })
  );
  const audits = Array.from({ length: auditCount }, (_, index) => ({
    id: `audit-${String(index + 1).padStart(5, '0')}`,
    at: '2026-08-20T12:00:00-07:00',
    actor: 'fixture',
    action: 'fixture-generated',
    result: 'success'
  }));

  return makeState({ requests, samples, channels, records, audits });
}
