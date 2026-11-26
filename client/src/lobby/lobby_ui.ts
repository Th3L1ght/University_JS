/**
 * Лобі: суворо типізований DOM-інтерфейс на чистому TypeScript (без важких UI-фреймворків).
 * Увесь вміст формується через textContent/атрибути (без innerHTML).
 */

import type { PlayerSummary, RoomSummary } from '@dogfight/shared';
import type { Lobby } from './lobby.ts';

const NICKNAME_KEY = 'dogfight.nickname';
const MAX_CHAT_LINES = 200;

const ERROR_TEXT: Readonly<Record<string, string>> = {
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

const MODE_TEXT: Readonly<Record<string, string>> = {
  server: 'сервер',
  static: 'статичний список (сервер недоступний)',
  embedded: 'вбудовані дані (режим file://)',
};

function readSavedNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveNickname(value: string): void {
  try {
    localStorage.setItem(NICKNAME_KEY, value);
  } catch {
    /* не критично */
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className = ''): HTMLButtonElement {
  const node = element('button', `lobby__button ${className}`.trim(), label);
  node.type = 'button';
  return node;
}

export interface LobbyUiHandle {
  show(): void;
  hide(): void;
  destroy(): void;
}

export function createLobbyUi({
  container,
  lobby,
  onBeforeJoin,
}: {
  readonly container: HTMLElement;
  readonly lobby: Lobby;
  readonly onBeforeJoin?: () => void;
}): LobbyUiHandle {
  const root = element('section', 'lobby');
  root.setAttribute('aria-label', 'Лобі');

  const title = element('h1', 'lobby__title', 'DOGFIGHT');
  const subtitle = element('p', 'lobby__subtitle', 'Оберіть кімнату й введіть нікнейм');
  const modeBadge = element('p', 'lobby__mode', '');

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

  let selectedId: string | null = null;
  let rooms: readonly RoomSummary[] = [];
  let currentRoom: RoomSummary | null = null;
  let myPlayerId: string | null = null;
  let selectAfterRefresh: string | null = null;

  const serverMode = (): boolean => lobby.mode === 'server';

  function showError(message: string): void {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function updateMode(): void {
    modeBadge.textContent = `Режим: ${MODE_TEXT[lobby.mode] ?? lobby.mode}`;
    createForm.hidden = !serverMode();
    joinButton.textContent = serverMode() ? 'Увійти в кімнату' : 'Join';
    subtitle.textContent = serverMode()
      ? 'Створіть кімнату або увійдіть у наявну: чат і список гравців працюють у реальному часі'
      : 'Оберіть кімнату й введіть нікнейм (сервер недоступний - гра локальна)';
  }

  function updateJoinState(): void {
    const room = rooms.find((candidate) => candidate.id === selectedId);
    joinButton.disabled = !room || room.players >= room.maxPlayers;
  }

  function renderRooms(): void {
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

      const arena = room.arena;
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

      const select = (): void => {
        selectedId = room.id;
        errorBox.hidden = true;
        renderRooms();
        updateJoinState();
      };
      item.addEventListener('click', select);
      item.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.code === 'Enter' || event.code === 'Space') {
          event.preventDefault();
          select();
        }
      });
      list.append(item);
    }
  }

  function showPanel(inRoom: boolean): void {
    browse.hidden = inRoom;
    panel.hidden = !inRoom;
  }

  function renderRoster(players: readonly PlayerSummary[]): void {
    roster.replaceChildren();
    for (const player of players) {
      const isMe = player.id === myPlayerId;
      roster.append(
        element(
          'li',
          `lobby__player${isMe ? ' lobby__player--me' : ''}`,
          isMe ? `${player.nickname} (ви)` : player.nickname,
        ),
      );
    }
  }

  function appendChat(entry: {
    readonly system?: boolean;
    readonly nickname?: string;
    readonly text: string;
  }): void {
    const line = element(
      'li',
      `lobby__chat-line${entry.system ? ' lobby__chat-line--system' : ''}`,
    );
    if (entry.system) {
      line.textContent = entry.text;
    } else {
      line.append(
        element('strong', 'lobby__chat-author', `${entry.nickname ?? ''}: `),
        document.createTextNode(entry.text),
      );
    }
    chatLog.append(line);
    while (chatLog.children.length > MAX_CHAT_LINES) chatLog.firstElementChild?.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  const readDetail = (event: Event): Record<string, unknown> =>
    event instanceof CustomEvent && event.detail && typeof event.detail === 'object'
      ? { ...event.detail }
      : {};

  const onRoomsUpdated: EventListener = (event) => {
    const d = readDetail(event);
    rooms = Array.isArray(d.rooms) ? d.rooms : [];
    if (selectAfterRefresh && rooms.some((r) => r.id === selectAfterRefresh)) {
      selectedId = selectAfterRefresh;
      selectAfterRefresh = null;
    } else if (!rooms.some((r) => r.id === selectedId)) {
      const open = rooms.find((r) => r.players < r.maxPlayers);
      selectedId = open?.id ?? rooms[0]?.id ?? null;
    }
    updateMode();
    status.textContent = rooms.length
      ? `Кімнат: ${rooms.length} · оновлено о ${new Date().toLocaleTimeString()}`
      : 'Поки немає кімнат - створіть першу';
    errorBox.hidden = true;
    renderRooms();
    updateJoinState();
  };

  const onError: EventListener = (event) => {
    const d = readDetail(event);
    const kind = typeof d.kind === 'string' ? d.kind : 'invalid';
    const errMsg = d.error instanceof Error ? d.error.message : '';
    const message = errMsg || ERROR_TEXT[kind] || 'Невідома помилка';
    if (currentRoom) appendChat({ system: true, text: `Помилка: ${message}` });
    else showError(message);
  };

  const onRoomCreated: EventListener = (event) => {
    const d = readDetail(event);
    if (d.room && typeof d.room === 'object' && 'id' in d.room && typeof d.room.id === 'string') {
      selectAfterRefresh = d.room.id;
    }
    createInput.value = '';
  };

  const onEntered: EventListener = (event) => {
    const d = readDetail(event);
    const room = d.room && typeof d.room === 'object' ? { ...d.room } : null;
    if (!room || !('id' in room) || !('name' in room)) return;
    currentRoom = {
      id: String(room.id),
      name: String(room.name),
      map: 'map' in room ? String(room.map) : '',
      mode: 'mode' in room ? String(room.mode) : '',
      players: 'players' in room && typeof room.players === 'number' ? room.players : 1,
      maxPlayers: 'maxPlayers' in room && typeof room.maxPlayers === 'number' ? room.maxPlayers : 8,
      arena: {},
      replayId: null,
    };
    myPlayerId = typeof d.playerId === 'string' ? d.playerId : null;
    errorBox.hidden = true;
    roomTitle.textContent = `Кімната: ${currentRoom.name}`;
    chatLog.replaceChildren();
    appendChat({ system: true, text: `Ви увійшли як ${String(d.nickname ?? '')}` });
    renderRoster(Array.isArray(d.players) ? d.players : []);
    connectionStatus.textContent = 'З’єднано';
    showPanel(true);
    chatInput.focus();
  };

  const onRoster: EventListener = (event) => {
    const d = readDetail(event);
    if (Array.isArray(d.players)) renderRoster(d.players);
  };

  const onChat: EventListener = (event) => {
    const d = readDetail(event);
    if (typeof d.text === 'string') {
      appendChat({
        nickname: typeof d.nickname === 'string' ? d.nickname : '',
        text: d.text,
      });
    }
  };

  const onConnection: EventListener = (event) => {
    const d = readDetail(event);
    const state = d.state;
    if (state === 'connected') connectionStatus.textContent = 'З’єднано';
    if (state === 'reconnecting') {
      connectionStatus.textContent = `З’єднання втрачено. Перепідключення (спроба ${String(d.attempt)}, через ${String(d.delayMs)} мс)…`;
      appendChat({ system: true, text: 'З’єднання втрачено, пробую перепідключитись…' });
    }
    if (state === 'disconnected' && !d.willReconnect) connectionStatus.textContent = 'Відключено';
    if (state === 'failed') connectionStatus.textContent = 'Не вдалося відновити з’єднання';
  };

  const onLeft: EventListener = () => {
    currentRoom = null;
    myPlayerId = null;
    showPanel(false);
    void lobby.refresh();
  };

  const onJoined: EventListener = () => hide();

  const subscriptions: readonly (readonly [string, EventListener])[] = [
    ['roomsUpdated', onRoomsUpdated],
    ['error', onError],
    ['roomCreated', onRoomCreated],
    ['entered', onEntered],
    ['roster', onRoster],
    ['chat', onChat],
    ['connection', onConnection],
    ['left', onLeft],
    ['joined', onJoined],
  ];
  for (const [type, handler] of subscriptions) lobby.addEventListener(type, handler);

  refreshButton.addEventListener('click', () => {
    status.textContent = 'Оновлюю…';
    void lobby.refresh();
  });

  createForm.addEventListener('submit', (event: SubmitEvent) => {
    event.preventDefault();
    const name = createInput.value.trim();
    if (!name) return;
    createButton.disabled = true;
    void lobby.createRoom({ name }).finally(() => {
      createButton.disabled = false;
    });
  });

  joinButton.addEventListener('click', () => {
    if (!selectedId) return;
    const value = nickname.value.trim();
    if (value) saveNickname(value);
    if (!serverMode()) onBeforeJoin?.();
    void lobby.enterRoom(selectedId, { nickname: value });
  });

  chatForm.addEventListener('submit', (event: SubmitEvent) => {
    event.preventDefault();
    if (lobby.sendChat(chatInput.value) !== null) chatInput.value = '';
  });

  leaveButton.addEventListener('click', () => lobby.leaveRoom());

  startButton.addEventListener('click', () => {
    if (!currentRoom) return;
    onBeforeJoin?.();
    void lobby.join(currentRoom.id, {
      nickname: nickname.value.trim(),
      keepConnection: serverMode(),
    });
  });

  updateMode();

  function show(): void {
    root.hidden = false;
  }
  function hide(): void {
    root.hidden = true;
  }

  return {
    show,
    hide,
    destroy() {
      for (const [type, handler] of subscriptions) lobby.removeEventListener(type, handler);
      root.remove();
    },
  };
}
