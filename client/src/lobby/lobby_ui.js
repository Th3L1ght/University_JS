/**
 * Лобі: DOM-інтерфейс. Підписується на події Lobby і показує:
 *   - список кімнат, форму створення кімнати, нікнейм, кнопки Оновити / Join;
 *   - після входу в кімнату на сервері: живий список гравців (roster), чат у реальному часі,
 *     стан з'єднання та кнопку запуску локального матчу.
 * Без сервера (статичний хостинг або file://) працює як у Лабі №3: Join одразу запускає матч.
 *
 * Увесь вміст формується через textContent/атрибути (без innerHTML), тому нікнейми, назви
 * кімнат і повідомлення чату не можуть впровадити розмітку.
 */

const NICKNAME_KEY = 'dogfight.nickname';
const MAX_CHAT_LINES = 200;

const ERROR_TEXT = {
  timeout: 'Сервер не відповів за 3 с',
  http: 'Сервер повернув помилку',
  network: 'Немає зв’язку із сервером',
  parse: 'Відповідь сервера пошкоджена (некоректний JSON)',
  invalid: 'Сервер повернув некоректні дані',
  offline: 'Недоступно без сервера',
  'room-full': 'Кімната заповнена',
  full: 'Кімната заповнена',
  'not-found': 'Кімнату не знайдено',
  'auth-timeout': 'Сервер закрив з’єднання: join не надійшов вчасно',
  policy: 'Сервер закрив з’єднання через порушення політики (ліміт повідомлень?)',
  'slow-consumer': 'Сервер відключив вас: ви не встигаєте читати повідомлення',
};

const MODE_TEXT = {
  server: 'сервер',
  static: 'статичний список (сервер недоступний)',
  embedded: 'вбудовані дані (режим file://)',
};

function readSavedNickname() {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return ''; // сховище може бути недоступним (приватне вікно, file:// у деяких браузерах)
  }
}

function saveNickname(value) {
  try {
    localStorage.setItem(NICKNAME_KEY, value);
  } catch {
    /* не критично */
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className = '') {
  const node = element('button', `lobby__button ${className}`.trim(), label);
  node.type = 'button';
  return node;
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container куди додати інтерфейс
 * @param {import('./lobby.js').Lobby} options.lobby
 * @param {() => void} [options.onBeforeJoin] викликається синхронно в обробнику кліку, що запускає
 *   матч (тут розблоковується AudioContext: це вимагає жесту користувача)
 */
export function createLobbyUi({ container, lobby, onBeforeJoin }) {
  const root = element('section', 'lobby');
  root.setAttribute('aria-label', 'Лобі');

  const title = element('h1', 'lobby__title', 'DOGFIGHT');
  const subtitle = element('p', 'lobby__subtitle', 'Оберіть кімнату й введіть нікнейм');
  const modeBadge = element('p', 'lobby__mode', '');

  // --- Вигляд 1: вибір кімнати ---
  const browse = element('div', 'lobby__browse');

  const nicknameLabel = element('label', 'lobby__label', 'Нікнейм');
  const nickname = element('input', 'lobby__input');
  nickname.type = 'text';
  nickname.maxLength = 16;
  nickname.placeholder = 'Pilot';
  nickname.autocomplete = 'off';
  nickname.value = readSavedNickname();
  nicknameLabel.append(nickname);

  const list = element('ul', 'lobby__rooms');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Кімнати');

  const createForm = element('form', 'lobby__create');
  const createInput = element('input', 'lobby__input');
  createInput.type = 'text';
  createInput.maxLength = 40;
  createInput.placeholder = 'Назва нової кімнати';
  createInput.autocomplete = 'off';
  const createButton = element('button', 'lobby__button lobby__button--secondary', 'Створити');
  createButton.type = 'submit';
  createForm.append(createInput, createButton);

  const status = element('p', 'lobby__status', 'Завантажую список кімнат…');
  const errorBox = element('p', 'lobby__error');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const refreshButton = button('Оновити', 'lobby__button--secondary');
  const joinButton = button('Join');
  joinButton.disabled = true;
  const browseActions = element('div', 'lobby__actions');
  browseActions.append(refreshButton, joinButton);

  browse.append(nicknameLabel, list, createForm, status, errorBox, browseActions);

  // --- Вигляд 2: кімната (roster + чат) ---
  const panel = element('div', 'lobby__panel');
  panel.hidden = true;
  const roomTitle = element('h2', 'lobby__room-title', '');
  const connectionStatus = element('p', 'lobby__status', '');
  const roster = element('ul', 'lobby__roster');
  roster.setAttribute('aria-label', 'Гравці в кімнаті');
  const chatLog = element('ul', 'lobby__chat');
  chatLog.setAttribute('role', 'log');
  chatLog.setAttribute('aria-live', 'polite');
  const chatForm = element('form', 'lobby__chat-form');
  const chatInput = element('input', 'lobby__input');
  chatInput.type = 'text';
  chatInput.maxLength = 200;
  chatInput.placeholder = 'Повідомлення…';
  chatInput.autocomplete = 'off';
  const chatSend = element('button', 'lobby__button lobby__button--secondary', 'Надіслати');
  chatSend.type = 'submit';
  chatForm.append(chatInput, chatSend);

  const rosterColumn = element('div', 'lobby__column');
  rosterColumn.append(element('h3', 'lobby__heading', 'Гравці'), roster);
  const chatColumn = element('div', 'lobby__column lobby__column--wide');
  chatColumn.append(element('h3', 'lobby__heading', 'Чат'), chatLog, chatForm);
  const columns = element('div', 'lobby__columns');
  columns.append(rosterColumn, chatColumn);

  const leaveButton = button('Покинути', 'lobby__button--secondary');
  const startButton = button('Почати матч');
  const panelActions = element('div', 'lobby__actions');
  panelActions.append(leaveButton, startButton);
  panel.append(roomTitle, connectionStatus, columns, panelActions);

  root.append(title, subtitle, modeBadge, browse, panel);
  container.append(root);

  // --- Стан ---
  let selectedId = null;
  let rooms = [];
  let currentRoom = null; // кімната, у якій гравець зараз (режим server)
  let myPlayerId = null;
  let selectAfterRefresh = null;

  const serverMode = () => lobby.mode === 'server';

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function updateMode() {
    modeBadge.textContent = `Режим: ${MODE_TEXT[lobby.mode] ?? lobby.mode}`;
    createForm.hidden = !serverMode();
    joinButton.textContent = serverMode() ? 'Увійти в кімнату' : 'Join';
    subtitle.textContent = serverMode()
      ? 'Створіть кімнату або увійдіть у наявну: чат і список гравців працюють у реальному часі'
      : 'Оберіть кімнату й введіть нікнейм (сервер недоступний - гра локальна)';
  }

  function updateJoinState() {
    const room = rooms.find((candidate) => candidate.id === selectedId);
    joinButton.disabled = !room || room.players >= room.maxPlayers;
  }

  function renderRooms() {
    list.replaceChildren();
    for (const room of rooms) {
      const full = room.players >= room.maxPlayers;
      const item = element('li', 'lobby__room');
      item.setAttribute('role', 'option');
      item.tabIndex = 0;
      item.dataset.roomId = room.id;
      item.setAttribute('aria-selected', String(room.id === selectedId));
      if (room.id === selectedId) item.classList.add('lobby__room--selected');
      if (full) item.classList.add('lobby__room--full');

      const arena = room.arena ?? {};
      item.append(
        element('span', 'lobby__room-name', room.name),
        element('span', 'lobby__room-players', `${room.players}/${room.maxPlayers}`),
        element('span', 'lobby__room-meta', `${room.map} · ${room.mode}`),
        element(
          'span',
          'lobby__room-params',
          `астероїдів: ${arena.initialAsteroids ?? '—'} · мисливців: ${
            arena.hunterChance === undefined ? '—' : `${Math.round(arena.hunterChance * 100)}%`
          }`,
        ),
      );

      const select = () => {
        selectedId = room.id;
        renderRooms();
        list.querySelector(`[data-room-id="${CSS.escape(room.id)}"]`)?.focus();
      };
      item.addEventListener('click', select);
      item.addEventListener('keydown', (event) => {
        if (event.code === 'Enter' || event.code === 'Space') {
          event.preventDefault();
          select();
        }
      });
      list.append(item);
    }
    updateJoinState();
  }

  function renderRoster(players) {
    roster.replaceChildren();
    for (const player of players) {
      const item = element('li', 'lobby__player', player.nickname);
      if (player.id === myPlayerId) item.classList.add('lobby__player--me');
      roster.append(item);
    }
  }

  function appendChat({ nickname: author, text, system = false }) {
    const item = element(
      'li',
      system ? 'lobby__chat-line lobby__chat-line--system' : 'lobby__chat-line',
    );
    if (system) {
      item.textContent = text;
    } else {
      item.append(
        element('strong', 'lobby__chat-author', `${author}: `),
        document.createTextNode(text),
      );
    }
    chatLog.append(item);
    while (chatLog.children.length > MAX_CHAT_LINES) chatLog.firstElementChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function showPanel(visible) {
    panel.hidden = !visible;
    browse.hidden = visible;
    subtitle.hidden = visible;
  }

  // --- Підписки на події лобі ---
  const onRoomsUpdated = (event) => {
    rooms = event.detail.rooms;
    if (selectAfterRefresh && rooms.some((room) => room.id === selectAfterRefresh)) {
      selectedId = selectAfterRefresh;
    }
    selectAfterRefresh = null;
    if (!rooms.some((room) => room.id === selectedId)) selectedId = null;
    errorBox.hidden = true;
    updateMode();
    const time = new Date(event.detail.updatedAt).toLocaleTimeString('uk-UA');
    status.textContent = `Оновлено ${time} · кімнат: ${rooms.length}`;
    renderRooms();
  };

  const onError = (event) => {
    const { error, kind } = event.detail;
    const base = ERROR_TEXT[kind];
    showError(base && base !== error.message ? `${base}. ${error.message}` : error.message);
  };

  const onRoomCreated = (event) => {
    selectAfterRefresh = event.detail.room.id;
    createInput.value = '';
  };

  const onEntered = (event) => {
    currentRoom = event.detail.room;
    myPlayerId = event.detail.playerId;
    errorBox.hidden = true;
    roomTitle.textContent = `Кімната: ${currentRoom.name}`;
    chatLog.replaceChildren();
    appendChat({ system: true, text: `Ви увійшли як ${event.detail.nickname}` });
    renderRoster(event.detail.players);
    connectionStatus.textContent = 'З’єднано';
    showPanel(true);
    chatInput.focus();
  };

  const onRoster = (event) => renderRoster(event.detail.players);
  const onChat = (event) => appendChat(event.detail);

  const onConnection = (event) => {
    const { state, attempt, delayMs } = event.detail;
    if (state === 'connected') connectionStatus.textContent = 'З’єднано';
    if (state === 'reconnecting') {
      connectionStatus.textContent = `З’єднання втрачено. Перепідключення (спроба ${attempt}, через ${delayMs} мс)…`;
      appendChat({ system: true, text: 'З’єднання втрачено, пробую перепідключитись…' });
    }
    if (state === 'disconnected' && !event.detail.willReconnect)
      connectionStatus.textContent = 'Відключено';
    if (state === 'failed') connectionStatus.textContent = 'Не вдалося відновити з’єднання';
  };

  const onLeft = () => {
    currentRoom = null;
    myPlayerId = null;
    showPanel(false);
    lobby.refresh();
  };

  const onJoined = () => hide();

  const subscriptions = {
    roomsUpdated: onRoomsUpdated,
    error: onError,
    roomCreated: onRoomCreated,
    entered: onEntered,
    roster: onRoster,
    chat: onChat,
    connection: onConnection,
    left: onLeft,
    joined: onJoined,
  };
  for (const [type, handler] of Object.entries(subscriptions))
    lobby.addEventListener(type, handler);

  // --- Дії користувача ---
  refreshButton.addEventListener('click', () => {
    status.textContent = 'Оновлюю…';
    lobby.refresh();
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = createInput.value.trim();
    if (!name) return;
    createButton.disabled = true;
    await lobby.createRoom({ name });
    createButton.disabled = false;
  });

  joinButton.addEventListener('click', () => {
    const value = nickname.value.trim();
    if (value) saveNickname(value);
    if (serverMode()) {
      lobby.enterRoom(selectedId, { nickname: value });
    } else {
      // Без сервера Join одразу запускає матч; жест користувача ще діє - розблоковуємо звук.
      onBeforeJoin?.();
      lobby.enterRoom(selectedId, { nickname: value });
    }
  });

  chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (lobby.sendChat(chatInput.value) !== null) chatInput.value = '';
  });

  leaveButton.addEventListener('click', () => lobby.leaveRoom());

  startButton.addEventListener('click', () => {
    onBeforeJoin?.(); // спершу синхронно (поки діє жест користувача) - розблокування звуку
    lobby.join(currentRoom.id, {
      nickname: nickname.value.trim(),
      keepConnection: serverMode(),
    });
  });

  updateMode();

  function show() {
    root.hidden = false;
  }
  function hide() {
    root.hidden = true;
  }

  return {
    show,
    hide,
    /** Знімає підписки й прибирає DOM. */
    destroy() {
      for (const [type, handler] of Object.entries(subscriptions))
        lobby.removeEventListener(type, handler);
      root.remove();
    },
  };
}
