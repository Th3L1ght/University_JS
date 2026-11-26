/**
 * Лобі: DOM-інтерфейс. Підписується на події Lobby (roomsUpdated, error, joined), дозволяє
 * ввести нікнейм, вибрати кімнату, оновити список вручну й натиснути Join.
 * Увесь вміст формується через textContent/атрибути (без innerHTML), тому нікнейми й назви
 * кімнат не можуть впровадити розмітку.
 */

const NICKNAME_KEY = 'dogfight.nickname';

const ERROR_TEXT = {
  timeout: 'Сервер не відповів за 3 с',
  http: 'Сервер повернув помилку',
  network: 'Немає зв’язку із сервером',
  parse: 'Відповідь сервера пошкоджена (некоректний JSON)',
  invalid: 'Сервер повернув некоректні дані',
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

/**
 * @param {object} options
 * @param {HTMLElement} options.container куди додати інтерфейс
 * @param {import('./lobby.js').Lobby} options.lobby
 * @param {() => void} [options.onBeforeJoin] викликається синхронно в обробнику кліку Join
 *   (тут розблоковується AudioContext: це вимагає жесту користувача)
 */
export function createLobbyUi({ container, lobby, onBeforeJoin }) {
  const root = element('section', 'lobby');
  root.setAttribute('aria-label', 'Лобі');

  const title = element('h1', 'lobby__title', 'DOGFIGHT');
  const subtitle = element('p', 'lobby__subtitle', 'Оберіть кімнату й введіть нікнейм');

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

  const status = element('p', 'lobby__status', 'Завантажую список кімнат…');
  const errorBox = element('p', 'lobby__error');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;

  const refreshButton = element('button', 'lobby__button lobby__button--secondary', 'Оновити');
  refreshButton.type = 'button';
  const joinButton = element('button', 'lobby__button', 'Join');
  joinButton.type = 'button';
  joinButton.disabled = true;
  const actions = element('div', 'lobby__actions');
  actions.append(refreshButton, joinButton);

  root.append(title, subtitle, nicknameLabel, list, status, errorBox, actions);
  container.append(root);

  let selectedId = null;
  let rooms = [];

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

      const name = element('span', 'lobby__room-name', room.name);
      const meta = element('span', 'lobby__room-meta', `${room.map} · ${room.mode}`);
      const players = element('span', 'lobby__room-players', `${room.players}/${room.maxPlayers}`);
      const arena = room.arena ?? {};
      const params = element(
        'span',
        'lobby__room-params',
        `астероїдів: ${arena.initialAsteroids ?? '—'} · мисливців: ${
          arena.hunterChance === undefined ? '—' : `${Math.round(arena.hunterChance * 100)}%`
        }`,
      );
      item.append(name, players, meta, params);

      const select = () => {
        selectedId = room.id;
        renderRooms();
        updateJoinState();
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

  const onRoomsUpdated = (event) => {
    rooms = event.detail.rooms;
    if (!rooms.some((room) => room.id === selectedId)) selectedId = null;
    errorBox.hidden = true;
    const time = new Date(event.detail.updatedAt).toLocaleTimeString('uk-UA');
    const source = event.detail.source === 'embedded' ? 'вбудовані дані (режим file://)' : 'сервер';
    status.textContent = `Оновлено ${time} · джерело: ${source}`;
    renderRooms();
  };

  const onError = (event) => {
    const { error, kind } = event.detail;
    const base = ERROR_TEXT[kind];
    errorBox.textContent = base ? `${base}. ${error.message}` : error.message;
    errorBox.hidden = false;
  };

  const onJoined = () => hide();

  lobby.addEventListener('roomsUpdated', onRoomsUpdated);
  lobby.addEventListener('error', onError);
  lobby.addEventListener('joined', onJoined);

  refreshButton.addEventListener('click', () => {
    status.textContent = 'Оновлюю…';
    lobby.refresh();
  });

  joinButton.addEventListener('click', () => {
    // Спершу синхронно (поки діє жест користувача) - розблокування звуку, потім join.
    onBeforeJoin?.();
    const value = nickname.value.trim();
    if (value) saveNickname(value);
    lobby.join(selectedId, { nickname: value });
  });

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
      lobby.removeEventListener('roomsUpdated', onRoomsUpdated);
      lobby.removeEventListener('error', onError);
      lobby.removeEventListener('joined', onJoined);
      root.remove();
    },
  };
}
