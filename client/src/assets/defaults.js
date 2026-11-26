/**
 * Резервні дані, вбудовані в код. Використовуються, коли гру відкрито як локальний файл
 * (file://) і браузер забороняє fetch. Ті самі значення scripts/generate_assets.mjs записує в
 * public/assets/arena.json і public/api/rooms.json.
 */

/** Правила арени за замовчуванням (ключі збігаються з WORLD_RULES у sim/world.js). */
export const DEFAULT_ARENA = Object.freeze({
  version: 1,
  rules: Object.freeze({
    initialAsteroids: 6,
    minAsteroids: 5,
    asteroidRefillDelay: 2.5,
    hunterChance: 0.3,
    respawnDelay: 2,
    respawnInvulnerability: 2,
    pickupInterval: 9,
    maxPickups: 2,
  }),
});

/** Кімнати лобі за замовчуванням. */
export const DEFAULT_ROOMS = Object.freeze({
  rooms: Object.freeze([
    {
      id: 'training',
      name: 'Тренувальний полігон',
      map: 'Open Space',
      mode: 'Sandbox',
      players: 1,
      maxPlayers: 8,
      arena: {
        initialAsteroids: 4,
        minAsteroids: 3,
        hunterChance: 0.1,
        pickupInterval: 6,
        seed: 101,
      },
    },
    {
      id: 'belt',
      name: 'Пояс астероїдів',
      map: 'Asteroid Belt',
      mode: 'Survival',
      players: 3,
      maxPlayers: 8,
      arena: {
        initialAsteroids: 9,
        minAsteroids: 8,
        hunterChance: 0.3,
        pickupInterval: 9,
        seed: 202,
      },
    },
    {
      id: 'hunters',
      name: 'Полювання',
      map: 'Red Nebula',
      mode: 'Hunters',
      players: 5,
      maxPlayers: 8,
      arena: {
        initialAsteroids: 6,
        minAsteroids: 6,
        hunterChance: 0.85,
        pickupInterval: 7,
        seed: 303,
      },
    },
    {
      id: 'full',
      name: 'Зал слави (заповнено)',
      map: 'Arena Prime',
      mode: 'Deathmatch',
      players: 8,
      maxPlayers: 8,
      arena: {
        initialAsteroids: 5,
        minAsteroids: 5,
        hunterChance: 0.5,
        pickupInterval: 8,
        seed: 404,
      },
    },
  ]),
});
