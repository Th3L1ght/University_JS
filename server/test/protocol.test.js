import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CloseCode,
  encodeServerMessage,
  makeRoomId,
  parseClientMessage,
  validateRoomInput,
} from '../src/protocol.js';

const parse = (object, options) => parseClientMessage(JSON.stringify(object), options);

describe('parseClientMessage: коректні повідомлення', () => {
  test('join', () => {
    const result = parse({ v: 1, type: 'join', room: 'arena-1', nickname: '  Maverick ' });
    assert.deepEqual(result, {
      ok: true,
      message: { type: 'join', room: 'arena-1', nickname: 'Maverick' },
    });
  });

  test('chat обрізає пробіли', () => {
    const result = parse({ v: 1, type: 'chat', text: '  привіт  ' });
    assert.deepEqual(result, { ok: true, message: { type: 'chat', text: 'привіт' } });
  });

  test('leave без полів і ping із необов’язковим t', () => {
    assert.deepEqual(parse({ v: 1, type: 'leave' }), { ok: true, message: { type: 'leave' } });
    assert.deepEqual(parse({ v: 1, type: 'ping' }), { ok: true, message: { type: 'ping' } });
    assert.deepEqual(parse({ v: 1, type: 'ping', t: 12.5 }), {
      ok: true,
      message: { type: 'ping', t: 12.5 },
    });
  });

  test('приймає Buffer', () => {
    const result = parseClientMessage(Buffer.from('{"v":1,"type":"leave"}'));
    assert.equal(result.ok, true);
  });
});

describe('parseClientMessage: відхилення й коди закриття', () => {
  const cases = [
    ['не JSON', '{not json', 'bad_json', CloseCode.INVALID_PAYLOAD],
    ['масив замість об’єкта', '[1,2]', 'bad_schema', CloseCode.INVALID_PAYLOAD],
    ['null', 'null', 'bad_schema', CloseCode.INVALID_PAYLOAD],
    ['без версії', '{"type":"leave"}', 'bad_version', CloseCode.INVALID_PAYLOAD],
    ['чужа версія', '{"v":2,"type":"leave"}', 'bad_version', CloseCode.INVALID_PAYLOAD],
    ['версія рядком', '{"v":"1","type":"leave"}', 'bad_version', CloseCode.INVALID_PAYLOAD],
    ['type не рядок', '{"v":1,"type":5}', 'bad_schema', CloseCode.INVALID_PAYLOAD],
    ['невідомий тип', '{"v":1,"type":"teleport"}', 'unknown_type', CloseCode.POLICY_VIOLATION],
    [
      'тип із прототипу',
      '{"v":1,"type":"constructor"}',
      'unknown_type',
      CloseCode.POLICY_VIOLATION,
    ],
    ['зайве поле', '{"v":1,"type":"leave","admin":true}', 'bad_schema', CloseCode.INVALID_PAYLOAD],
    [
      'join без кімнати',
      '{"v":1,"type":"join","nickname":"Pilot"}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'кімната з великих літер',
      '{"v":1,"type":"join","room":"ARENA","nickname":"Pilot"}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'кімната з path traversal',
      '{"v":1,"type":"join","room":"../etc","nickname":"Pilot"}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'короткий нікнейм',
      '{"v":1,"type":"join","room":"arena","nickname":"x"}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'довгий нікнейм',
      `{"v":1,"type":"join","room":"arena","nickname":"${'n'.repeat(17)}"}`,
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'керівні символи в нікнеймі',
      '{"v":1,"type":"join","room":"arena","nickname":"ab\\u0007cd"}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'порожній chat',
      '{"v":1,"type":"chat","text":"   "}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    [
      'chat довший за 200',
      `{"v":1,"type":"chat","text":"${'a'.repeat(201)}"}`,
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
    ['chat не рядком', '{"v":1,"type":"chat","text":123}', 'bad_schema', CloseCode.INVALID_PAYLOAD],
    [
      'ping з нечисловим t',
      '{"v":1,"type":"ping","t":"now"}',
      'bad_schema',
      CloseCode.INVALID_PAYLOAD,
    ],
  ];

  for (const [name, raw, code, closeCode] of cases) {
    test(name, () => {
      const result = parseClientMessage(raw);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(result.closeCode, closeCode);
      assert.ok(result.reason.length > 0);
    });
  }

  test('перевищення розміру -> 1009 ще до розбору JSON', () => {
    const result = parseClientMessage('x'.repeat(100), { maxBytes: 50 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'too_large');
    assert.equal(result.closeCode, CloseCode.MESSAGE_TOO_BIG);
  });

  test('розмір рахується в байтах, а не в символах', () => {
    const text = 'я'.repeat(40); // 40 символів = 80 байтів
    const raw = JSON.stringify({ v: 1, type: 'chat', text });
    assert.equal(parseClientMessage(raw, { maxBytes: 70 }).code, 'too_large');
    assert.equal(parseClientMessage(raw, { maxBytes: 200 }).ok, true);
  });
});

describe('encodeServerMessage', () => {
  test('додає версію й тип', () => {
    const parsed = JSON.parse(encodeServerMessage('pong', { t: 5 }));
    assert.deepEqual(parsed, { v: 1, type: 'pong', t: 5 });
  });

  test('відмовляється кодувати невідомий тип', () => {
    assert.throws(() => encodeServerMessage('nope'), /Невідомий тип/);
  });
});

describe('validateRoomInput', () => {
  test('значення за замовчуванням', () => {
    const result = validateRoomInput({ name: 'Арена Один' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      name: 'Арена Один',
      map: 'Open Space',
      mode: 'Sandbox',
      maxPlayers: 8,
      arena: {},
    });
  });

  test('повні дані з ареною', () => {
    const result = validateRoomInput(
      {
        name: 'Belt',
        map: 'M',
        mode: 'X',
        maxPlayers: 4,
        arena: { initialAsteroids: 9, hunterChance: 0.5 },
      },
      { maxPlayersLimit: 8 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.maxPlayers, 4);
    assert.deepEqual(result.value.arena, { initialAsteroids: 9, hunterChance: 0.5 });
  });

  const bad = [
    ['не об’єкт', 'text'],
    ['масив', []],
    ['немає name', {}],
    ['name закороткий', { name: 'a' }],
    ['name задовгий', { name: 'n'.repeat(41) }],
    ['зайве поле', { name: 'Room', admin: 1 }],
    ['maxPlayers поза межами', { name: 'Room', maxPlayers: 99 }],
    ['maxPlayers не ціле', { name: 'Room', maxPlayers: 3.5 }],
    ['arena не об’єкт', { name: 'Room', arena: 5 }],
    ['невідомий параметр арени', { name: 'Room', arena: { gravity: 9 } }],
    ['hunterChance > 1', { name: 'Room', arena: { hunterChance: 2 } }],
    ['arena-значення NaN-рядок', { name: 'Room', arena: { seed: 'x' } }],
  ];
  for (const [name, body] of bad) {
    test(`відхиляє: ${name}`, () => {
      const result = validateRoomInput(body);
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    });
  }
});

describe('makeRoomId', () => {
  test('латинський slug і суфікс; кирилиця дає запасний варіант', () => {
    assert.match(
      makeRoomId('Test Room', () => 0.5),
      /^test-room-8000$/,
    );
    assert.match(
      makeRoomId('Арена', () => 0),
      /^room-0000$/,
    );
    assert.match(
      makeRoomId('!!!', () => 0.1),
      /^room-[0-9a-f]{4}$/,
    );
  });

  test('завжди відповідає шаблону ідентифікатора кімнати', () => {
    for (const name of ['A', 'Very Long Room Name That Goes On And On Forever', 'x_y z']) {
      const parsed = parseClientMessage(
        JSON.stringify({ v: 1, type: 'join', room: makeRoomId(name), nickname: 'Pilot' }),
      );
      assert.equal(parsed.ok, true, makeRoomId(name));
    }
  });
});
