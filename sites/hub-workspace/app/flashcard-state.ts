import {dailyLimits, demoCards, reviewPlan, sessionLimits} from './flashcard-demo';

export const FLASH_STORAGE_KEY = 'hub-flashcard-prototype-v1';

export type FlashSession = {
  queue: string[];
  initialIds: string[];
  label: string;
  ratings: number[];
  revealed: boolean;
};

export type FlashState = {
  date: string;
  due: string[];
  studied: string[];
  reviewed: number;
  newToday: number;
  dailyLimit: number;
  sessionLimit: number;
  session: FlashSession | null;
};

const cardsById = new Map(demoCards.map(card => [card.id, card]));
const dateFormatter = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'});
const flashDay = (now: Date) => dateFormatter.format(now);
const uniqueIds = (ids: string[]) => [...new Set(ids)];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(id => typeof id === 'string' && cardsById.has(id));
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isRating = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4;

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function makeFlashState(now = new Date()): FlashState {
  return {
    date: flashDay(now),
    due: demoCards.map(card => card.id),
    studied: [],
    reviewed: 16,
    newToday: 1,
    dailyLimit: 10,
    sessionLimit: 20,
    session: null,
  };
}

function readSession(value: unknown, state: FlashState): FlashSession | null {
  if (!isRecord(value) || !isIdList(value.queue) || !isIdList(value.initialIds)
    || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100
    || !Array.isArray(value.ratings) || !value.ratings.every(isRating)
    || typeof value.revealed !== 'boolean') return null;

  const queue = uniqueIds(value.queue);
  const initialIds = uniqueIds(value.initialIds);
  if (!initialIds.length || queue.some(id => !initialIds.includes(id))) return null;
  // A pending card cannot count as completed merely because it disappeared from the queue.
  if (initialIds.some(id => state.due.includes(id) && !queue.includes(id))) return null;
  const isDeckSession = demoCards.some(card => card.deck === value.label);
  if (isDeckSession && initialIds.some(id => cardsById.get(id)?.deck !== value.label)) return null;
  return {queue, initialIds, label: value.label, ratings: value.ratings, revealed: Boolean(queue.length && value.revealed)};
}

export function loadFlashState(raw: string | null, now = new Date()): FlashState {
  const fallback = makeFlashState(now);
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isDateKey(value.date) || !isIdList(value.due)
      || !isIdList(value.studied) || !isCount(value.reviewed) || !isCount(value.newToday)
      || typeof value.dailyLimit !== 'number' || !dailyLimits.includes(value.dailyLimit)
      || typeof value.sessionLimit !== 'number' || !sessionLimits.includes(value.sessionLimit)) return fallback;

    const state: FlashState = {
      date: value.date,
      due: uniqueIds(value.due),
      studied: uniqueIds(value.studied),
      reviewed: value.reviewed,
      newToday: value.newToday,
      dailyLimit: value.dailyLimit,
      sessionLimit: value.sessionLimit,
      session: null,
    };
    // Older saves have no session. A corrupt session must not erase valid daily progress.
    state.session = readSession(value.session, state);
    return reconcileFlashSession(reconcileFlashDay(state, now));
  } catch {
    return fallback;
  }
}

export function reconcileFlashDay(state: FlashState, now = new Date()): FlashState {
  const date = flashDay(now);
  if (state.date === date) return state;
  return {
    ...makeFlashState(now),
    date,
    reviewed: 0,
    newToday: 0,
    dailyLimit: state.dailyLimit,
    sessionLimit: state.sessionLimit,
  };
}

export function buildFlashSession(state: FlashState, deck = ''): FlashSession | null {
  const {session} = reviewPlan(state.due, state.studied, state.dailyLimit, state.newToday, state.sessionLimit, deck);
  if (!session.length) return null;
  const ids = session.map(card => card.id);
  return {queue: ids, initialIds: [...ids], label: deck || '今日待复习', ratings: [], revealed: false};
}

export function reconcileFlashSession(state: FlashState): FlashState {
  const session = state.session;
  if (!session) return state;
  let allowance = state.dailyLimit === 0 ? Infinity : Math.max(0, state.dailyLimit - state.newToday);
  const removedNewIds = new Set<string>();
  const queue = uniqueIds(session.queue).filter(id => {
    const card = cardsById.get(id);
    if (!card || !state.due.includes(id)) return false;
    if (!card.isNew || state.studied.includes(id)) return true;
    if (allowance > 0) { allowance -= 1; return true; }
    removedNewIds.add(id);
    return false;
  });
  // Postponed unseen cards are not completed cards, so they also leave the progress denominator.
  const initialIds = session.initialIds.filter(id => !removedNewIds.has(id));
  if (!initialIds.length) return {...state, session: null};
  const revealed = Boolean(queue.length && queue[0] === session.queue[0] && session.revealed);
  if (queue.length === session.queue.length && queue.every((id, index) => id === session.queue[index])
    && initialIds.length === session.initialIds.length && revealed === session.revealed) return state;
  return {...state, session: {...session, queue, initialIds, revealed}};
}

export function applyFlashRating(state: FlashState, rating: number): FlashState {
  if (!isRating(rating)) return state;
  const currentState = reconcileFlashSession(state);
  const session = currentState.session;
  const card = cardsById.get(session?.queue[0] ?? '');
  if (!session?.revealed || !card) return currentState;
  const firstStudy = !currentState.studied.includes(card.id);
  const remaining = session.queue.slice(1);
  return reconcileFlashSession({
    ...currentState,
    due: rating === 1 ? currentState.due : currentState.due.filter(id => id !== card.id),
    studied: firstStudy ? [...currentState.studied, card.id] : currentState.studied,
    reviewed: Math.min(Number.MAX_SAFE_INTEGER, currentState.reviewed + 1),
    newToday: Math.min(Number.MAX_SAFE_INTEGER, currentState.newToday + (card.isNew && firstStudy ? 1 : 0)),
    session: {
      ...session,
      queue: rating === 1 ? [...remaining, card.id] : remaining,
      ratings: [...session.ratings, rating],
      revealed: false,
    },
  });
}

export function restoreFlashRating(current: FlashState, before: FlashState): FlashState {
  if (current.date !== before.date) return current;
  return reconcileFlashSession({...before, dailyLimit: current.dailyLimit, sessionLimit: current.sessionLimit});
}

export function getFlashCardStatus(card: typeof demoCards[number], state: FlashState): 'new' | 'due' | 'done' {
  if (!state.due.includes(card.id)) return 'done';
  return card.isNew && !state.studied.includes(card.id) ? 'new' : 'due';
}
