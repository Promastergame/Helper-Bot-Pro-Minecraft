'use strict';

process.env.COMBAT_CHATTER_CHANCE = '0';

const assert = require('assert');
const { Vec3 } = require('vec3');
const { attackByName, _setFollowAndHitHook } = require('./combat');

async function run(){
  const followCalls = [];
  _setFollowAndHitHook(async (bot, entity) => {
    followCalls.push({ bot, entity });
  });

  const bot = {
    players: {},
    entity: { position: new Vec3(0, 0, 0) },
    health: 20,
    chat: () => {},
    emit: () => {},
    entities: {
      near:   { id: 'near',   type: 'mob', name: 'Zombie', position: new Vec3(2, 0, 0), isValid: true },
      far:    { id: 'far',    type: 'mob', name: 'Zombie', position: new Vec3(6, 0, 0), isValid: true },
      ignore: { id: 'player', type: 'player', name: 'Steve', position: new Vec3(1, 0, 0) }
    }
  };

  const ok = await attackByName(bot, 'zombie');
  assert.strictEqual(ok, true, 'attackByName should resolve true for a valid mob target');
  assert.strictEqual(followCalls.length, 1, 'followAndHit should be called exactly once');
  assert.strictEqual(followCalls[0].entity.id, 'near', 'nearest suitable mob should be selected');

  console.log('✅ attackByName picks the closest allowed mob and proceeds to followAndHit');
  process.exit(0);
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
