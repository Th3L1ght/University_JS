import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CloseCode,
  encodeServerMessage,
  makeRoomId,
  parseClientMessage,
  PROTOCOL_VERSION,
  validateRoomInput,
} from '@dogfight/shared';

const frame = (obj: unknown): string => JSON.stringify(obj);

describe('parseClientMessage (Zod): коректні повідомлення', () => {
  test('join', () => {
    const result = parseClientMessage(
      frame({ v: PROTOCOL_VERSION, type: 'join', room: 'alpha-1', nickname: '  Maverick  ' }),
    );
    assert.deepEqual(result, {
      ok: true,
      data: { type: 'join', room: 'alpha-1', nickname: 'Maverick' },
    });
  });

  test('chat обрізає пробіли', () => {
    const result = parseClientMessage(frame({ v: 1, type: 'chat', text: '  Привіт!  ' }));
    assert.deepEqual(result, { ok: true, data: { type: 'chat', text: 'Привіт!' } });
  });

  test('leave без полів і ping із необов’язковим t', () => {
    assert.deepEqual(parseClientMessage(frame({ v: 1, type: 'leave' })), {
      ok: true,
      data: { type: 'leave' },
    });
    assert.deepEqual(parseClientMessage(frame({ v: 1, type: 'ping' })), {
      ok: true,
      data: { type: 'ping' },
    });
    assert.deepEqual(parseClientMessage(frame({ v: 1, type: 'ping', t: 42 })), {
      ok: true,
      data: { type: 'ping', t: 42 },
    });
  });
});

describe('parseClientMessage (Zod): відхилення й коди закриття', () => {
  const cases: readonly (readonly [string, string, number, string])[] = [
    ['не JSON', '{broken', CloseCode.INVALID_PAYLOAD, 'bad_json'],
    ['масив замість об’єкта', '[]', CloseCode.INVALID_PAYLOAD, 'bad_schema'],
    ['відсутня версія', frame({ type: 'leave' }), CloseCode.INVALID_PAYLOAD, 'bad_version'],
    ['чужа версія', frame({ v: 2, type: 'leave' }), CloseCode.INVALID_PAYLOAD, 'bad_version'],
    ['невідомий type', frame({ v: 1, type: 'hack' }), CloseCode.POLICY_VIOLATION, 'unknown_type'],
    [
      'зайве поле',
      frame({ v: 1, type: 'leave', extra: 1 }),
      CloseCode.INVALID_PAYLOAD,
      'bad_schema',
    ],
    [
      'поганий roomId',
      frame({ v: 1, type: 'join', room: '../etc', nickname: 'Ace' }),
      CloseCode.INVALID_PAYLOAD,
      'bad_schema',
    ],
    [
      'короткий nickname',
      frame({ v: 1, type: 'join', room: 'alpha-1', nickname: 'A' }),
      CloseCode.INVALID_PAYLOAD,
      'bad_schema',
    ],
    [
      'керівні символи в chat',
      frame({ v: 1, type: 'chat', text: 'hi\u0007' }),
      CloseCode.INVALID_PAYLOAD,
      'bad_schema',
    ],
  ];

  for (const [label, raw, closeCode, code] of cases) {
    test(label, () => {
      const result = parseClientMessage(raw);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.closeCode, closeCode);
        assert.equal(result.error.code, code);
      }
    });
  }

  test('перевищення maxBytes -> 1009', () => {
    const result = parseClientMessage(frame({ v: 1, type: 'chat', text: 'x'.repeat(200) }), {
      maxBytes: 50,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.closeCode, CloseCode.MESSAGE_TOO_BIG);
  });
});

describe('encodeServerMessage, validateRoomInput і makeRoomId', () => {
  test('encodeServerMessage додає v: 1', () => {
    const parsed = JSON.parse(encodeServerMessage({ type: 'pong', t: 5 }));
    assert.deepEqual(parsed, { v: 1, type: 'pong', t: 5 });
  });

  test('validateRoomInput через Zod: дефолти й помилки', () => {
    const ok = validateRoomInput({ name: '  Alpha  ' });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.data.name, 'Alpha');
      assert.equal(ok.data.maxPlayers, 8);
    }
    assert.equal(validateRoomInput({ name: 'A', maxPlayers: 99, extra: true }).ok, false);
  });

  test('makeRoomId створює латинський slug із hex-суфіксом', () => {
    assert.equal(
      makeRoomId('Alpha Squad!', () => 0),
      'alpha-squad-0000',
    );
    assert.equal(
      makeRoomId('!!!', () => 0.5),
      'room-8000',
    );
  });
});
