const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const preset = require('../lib/device-preset.js');

function canonicalSha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

test('approved preset is exactly 26 devices and 529 unique free channels', () => {
  const devices = preset.devices();
  const channels = preset.channels();

  assert.equal(preset.meta.deviceCount, 26);
  assert.equal(preset.meta.channelCount, 529);
  assert.equal(devices.length, 26);
  assert.equal(channels.length, 529);
  assert.equal(new Set(devices.map(item => item.id)).size, 26);
  assert.equal(new Set(devices.map(item => item.name)).size, 26);
  assert.equal(new Set(channels.map(item => item.key)).size, 529);
  assert.ok(channels.every(item => item.state === 'free'));
  assert.ok(channels.every(item => devices.some(device => device.name === item.device)));
  assert.equal(
    canonicalSha256({ devices, channels }),
    'a964640116eece6c5995f01b5f92e41ce3fc1ca08aae0b8b0bc45152c36f6bbf'
  );
});

test('preset accessors return isolated data that cannot mutate the authority', () => {
  const devices = preset.devices();
  const channels = preset.channels();
  devices[0].name = '被修改';
  channels[0].state = 'busy';

  assert.notEqual(preset.devices()[0].name, '被修改');
  assert.equal(preset.channels()[0].state, 'free');
});
