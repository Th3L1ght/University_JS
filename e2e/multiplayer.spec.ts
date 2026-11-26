import { expect, test } from '@playwright/test';

test('два гравці в одній кімнаті: roster, чат і синхронізація руху (< 500 мс)', async ({
  browser,
  request,
}) => {
  // Створюємо свіжу кімнату через REST API.
  const created = await request.post('/api/rooms', {
    data: { name: 'Playwright Arena', maxPlayers: 4 },
  });
  expect(created.status()).toBe(201);

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await Promise.all([pageA.goto('/?debug'), pageB.goto('/?debug')]);

    // Обидва гравці чекають завантаження лобі.
    await expect(pageA.locator('.lobby')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.locator('.lobby')).toBeVisible({ timeout: 10_000 });

    // Вводять нікнейми та заходять у створену кімнату.
    await pageA.locator('.lobby__browse .lobby__input').first().fill('PilotA');
    await pageA.locator('.lobby__room', { hasText: 'Playwright Arena' }).click();
    await pageA.getByRole('button', { name: 'Увійти в кімнату' }).click();

    await pageB.locator('.lobby__browse .lobby__input').first().fill('PilotB');
    await pageB.locator('.lobby__room', { hasText: 'Playwright Arena' }).click();
    await pageB.getByRole('button', { name: 'Увійти в кімнату' }).click();

    // Перевірка roster в обох вікнах.
    await expect(pageA.locator('.lobby__roster')).toContainText('PilotA');
    await expect(pageA.locator('.lobby__roster')).toContainText('PilotB');
    await expect(pageB.locator('.lobby__roster')).toContainText('PilotA');
    await expect(pageB.locator('.lobby__roster')).toContainText('PilotB');

    // Обмін повідомленнями в чаті.
    await pageA.locator('.lobby__chat-form .lobby__input').fill('Привіт від PilotA!');
    await pageA.getByRole('button', { name: 'Надіслати' }).click();
    await expect(pageB.locator('.lobby__chat')).toContainText('Привіт від PilotA!');

    // Обидва гравці починають матч.
    await pageA.getByRole('button', { name: 'Почати матч' }).click();
    await pageB.getByRole('button', { name: 'Почати матч' }).click();
    await expect(pageA.locator('.lobby')).toBeHidden();
    await expect(pageB.locator('.lobby')).toBeHidden();

    // Керування кораблем у вікні A та перевірка оновлення стану на сервері / у вікні B (< 500 мс).
    const before = await (await request.get('/api/stats')).json();
    const tickBefore = before.matches[0]?.tick ?? 0;

    const t0 = Date.now();
    await pageA.keyboard.down('ArrowUp');
    await pageA.waitForTimeout(250);
    await pageA.keyboard.up('ArrowUp');

    await expect
      .poll(
        async () => {
          const stats = await (await request.get('/api/stats')).json();
          return stats.matches[0]?.tick ?? 0;
        },
        { timeout: 500 },
      )
      .toBeGreaterThan(tickBefore + 3);

    expect(Date.now() - t0).toBeLessThan(1200);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
