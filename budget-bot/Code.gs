/**
 * Бюджет-бот: проверка покупок перед тратой, учёт гибких трат,
 * импорт экспорта MoneyLover с Google Диска и итоги в Telegram.
 * Работает целиком в Google Apps Script, без своего сервера.
 * Инструкция по установке — в README.md рядом.
 */

// ===== Настройки =====
const CATS = {
  cafe: 'Кафе и алкоголь',
  clothes: 'Одежда',
  market: 'Маркетплейсы',
  misc: 'Гаджеты, духи, перекусы',
  cash: 'Прочее / наличные',
};
const DEFAULT_LIMITS = { cafe: 360000, clothes: 2500000, market: 380000, misc: 230000, cash: 460000 };
const MONTHLY = ['clothes']; // лимит на месяц, остальные — на неделю
const BIG = 500000; // от этой суммы — правило 48 часов
const WAIT_H = 48;
const EXPENSES = 47.6; // средние расходы в месяц, млн (база плана)

// План экономии по 13 статьям: [ключ, название, было, цель] в млн сум в месяц
const PLAN = [
  ['cash', 'Наличные', 8.30, 5.80], ['clothes', 'Одежда', 3.15, 2.50], ['market', 'Маркетплейсы', 2.75, 1.65],
  ['food', 'Продукты', 2.70, 2.43], ['cafe', 'Кафе и алкоголь', 2.35, 1.55], ['subs', 'Подписки', 1.10, 0.35],
  ['gadgets', 'Гаджеты', 1.00, 0.50], ['car', 'Доработки авто', 0.73, 0.25], ['perfume', 'Духи', 0.50, 0.25],
  ['snacks', 'Перекусы', 0.44, 0.24], ['phone', 'Связь', 0.32, 0.12], ['fines', 'Штрафы', 0.28, 0], ['park', 'Парковка', 0.16, 0.06],
];

const CAFE_RE = /пив|водк|шашлык|бургер|ужин|обед|норин|калла|лаваш|сомса|safia|evos|евос|kfc|kfs|торт|сигар|кафе|ресторан/i;
const KEYBOARD = {
  keyboard: [[{ text: '📊 Сегодня' }, { text: '📅 Неделя' }], [{ text: '🛍 Список желаний' }, { text: '⚙️ Лимиты' }]],
  resize_keyboard: true,
  is_persistent: true,
};

// ===== Служебное =====
const props = () => PropertiesService.getScriptProperties();
const P = (k) => props().getProperty(k);
const owner = () => P('OWNER_CHAT_ID');
const limits = () => Object.assign({}, DEFAULT_LIMITS, JSON.parse(P('LIMITS') || '{}'));
const isM = (c) => MONTHLY.indexOf(c) >= 0;

function fmt(v) {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function k(v) {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a < 1000) return s + fmt(a) + ' сум';
  if (a >= 1e6) return s + (Math.round(a / 1e4) / 100).toString().replace('.', ',') + ' млн';
  return s + fmt(a / 1000) + ' тыс.';
}
function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MON_N = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const dayLabel = (d) => `${DAYS[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function weekStart(d) { const x = dayStart(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function monthStart(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

// ===== Telegram =====
function tg(method, payload) {
  const res = UrlFetchApp.fetch(`https://api.telegram.org/bot${P('TOKEN')}/${method}`, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText() || '{}');
}
function send(text, markup) {
  const chat = owner();
  if (!chat) return;
  text = text.replace(/\.\.(\s|$)/g, '.$1');
  tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_markup: markup || KEYBOARD, disable_web_page_preview: true });
}

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.k !== P('SECRET')) return ok();
    const u = JSON.parse(e.postData.contents);
    // Telegram повторяет запрос, если не получил 200 — не обрабатываем одно обновление дважды
    const cache = CacheService.getScriptCache();
    if (cache.get('u' + u.update_id)) return ok();
    cache.put('u' + u.update_id, '1', 21600);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { handle(u); } finally { lock.releaseLock(); }
  } catch (err) {
    console.error(err && err.stack || err);
  }
  return ok();
}
function doGet() { return ok(); }
function ok() { return ContentService.createTextOutput('ok'); }

function handle(u) {
  const msg = u.message;
  const cb = u.callback_query;
  const chatId = String(msg ? msg.chat.id : cb ? cb.message.chat.id : '');
  if (!chatId) return;

  if (!owner()) {
    if (msg && /^\/start/.test(msg.text || '')) {
      props().setProperty('OWNER_CHAT_ID', chatId);
      welcome();
    }
    return;
  }
  if (chatId !== owner()) return; // бот отвечает только владельцу

  if (cb) return onCallback(cb);
  const text = (msg.text || '').trim();
  if (!text) return;

  if (/^\/start/.test(text)) return welcome();
  if (/^\/help|^помощь/i.test(text)) return help();
  if (/^\/today|^📊/.test(text)) return send(todayText());
  if (/^\/week|^📅/.test(text)) return send(weekText(false));
  if (/^\/wish|^🛍/.test(text)) return showWish();
  if (/^\/limits|^⚙️/.test(text)) return showLimits();
  if (/^\/limit\s+/.test(text)) return setLimit(text);
  if (/^\/undo/.test(text)) return undo();
  if (/^\/import/.test(text)) { const r = importMoneyLover(); return send(r.found ? r.text : 'Сегодняшний экспорт MoneyLover на Диске не найден.'); }
  if (/^\/month/.test(text)) return send(monthText(new Date()));

  const parsed = parseAmount(text);
  if (!parsed) return send('Напишите сумму и, по желанию, что покупаете. Например: <b>150000 обед</b> или <b>1,2 млн наушники</b>. /help — все команды.');
  const draft = { a: parsed.a, n: parsed.note, c: guessCat(parsed.note) };
  saveDraft(draft);
  if (!draft.c) return askCategory(draft);
  showVerdict(draft);
}

function welcome() {
  send('Привет! Я ваш бюджет-бот.\n\n' +
    '• Перед покупкой напишите сумму, например <b>150000 обед</b>, и я скажу, можно ли.\n' +
    '• В 21:00 напомню выгрузить MoneyLover на Диск, в 21:30 сам внесу траты и пришлю итог дня.\n' +
    '• В воскресенье — итог недели, 2-го числа — итог месяца по плану экономии.\n\n/help — все команды.');
}
function help() {
  send('<b>Команды</b>\n' +
    '<b>150000 обед</b> — проверить покупку\n' +
    '/today — сегодня\n/week — неделя\n/wish — список желаний\n' +
    '/limits — лимиты\n/limit cafe 400000 — изменить лимит\n' +
    '/undo — удалить последнюю запись\n/import — забрать экспорт MoneyLover сейчас\n/month — итог месяца по плану\n\n' +
    'Ключи категорий: ' + Object.keys(CATS).map((c) => `${c} — ${CATS[c]}`).join(', '));
}

// ===== Разбор сообщения =====
function parseAmount(text) {
  const m = text.replace(/ /g, ' ').match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(млн|м|mln|m|тыс|т|к|k)?\.?/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
  const unit = (m[2] || '').toLowerCase();
  if (/^(млн|м|mln|m)$/.test(unit)) n *= 1e6;
  else if (/^(тыс|т|к|k)$/.test(unit)) n *= 1e3;
  else if (n < 1000) n *= 1000; // «150» понимаем как 150 тысяч
  n = Math.round(n);
  if (!(n > 0)) return null;
  const note = text.replace(m[0], '').replace(/\s+/g, ' ').trim();
  return { a: n, note };
}
function guessCat(note) {
  const s = (note || '').toLowerCase();
  if (!s) return null;
  if (CAFE_RE.test(s)) return 'cafe';
  if (/uzum|узум|wb|wildberries|pinduoduo|маркет|озон|ozon/.test(s)) return 'market';
  if (/одежд|кийим|обув|куртк|штан|платье|футболк|костюм/.test(s)) return 'clothes';
  if (/дух|парфюм|наушник|часы|гаджет|чехол|телефон|airpods|перекус|кофе|шоколад/.test(s)) return 'misc';
  if (/такси|налич|кино|развлеч|подарок/.test(s)) return 'cash';
  return null;
}
function saveDraft(d) { CacheService.getScriptCache().put('draft', JSON.stringify(d), 3600); }
function getDraft() { return JSON.parse(CacheService.getScriptCache().get('draft') || 'null'); }

function askCategory(d) {
  const C = calc();
  const rows = Object.keys(CATS).map((c) => [{ text: `${CATS[c]} · ${k(C.catLeft(c))}${isM(c) ? '/мес' : ''}`, callback_data: 'c:' + c }]);
  send(`Сумма <b>${fmt(d.a)}</b> сум${d.n ? ' — ' + esc(d.n) : ''}. Какая категория?`, { inline_keyboard: rows });
}

// ===== Данные =====
function sheet(name) {
  let id = P('SHEET_ID');
  let ss;
  if (id) ss = SpreadsheetApp.openById(id);
  else {
    ss = SpreadsheetApp.create('Бюджет-бот — данные');
    props().setProperty('SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const head = name === 'Log' ? ['id', 'время', 'сумма', 'категория', 'примечание', 'источник', 'ключ', 'сверх лимита'] : ['id', 'время', 'сумма', 'категория', 'примечание'];
    sh.appendRow(head);
    sh.setFrozenRows(1);
    const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('Лист1');
    if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  }
  return sh;
}
function readLog() {
  const v = sheet('Log').getDataRange().getValues().slice(1);
  return v.filter((r) => r[0]).map((r) => ({ id: String(r[0]), t: new Date(r[1]), a: +r[2], c: String(r[3]), n: String(r[4] || ''), src: String(r[5] || ''), key: String(r[6] || ''), ov: +r[7] || 0 }));
}
function readWish() {
  const v = sheet('Wish').getDataRange().getValues().slice(1);
  return v.filter((r) => r[0]).map((r) => ({ id: String(r[0]), t: new Date(r[1]), a: +r[2], c: String(r[3]), n: String(r[4] || '') }));
}
function addLog(e) { sheet('Log').appendRow([e.id, e.t, e.a, e.c, e.n || '', e.src || '', e.key || '', e.ov || '']); }
function addWish(e) { sheet('Wish').appendRow([e.id, e.t, e.a, e.c, e.n || '']); }
function deleteRow(name, id) {
  const sh = sheet(name), v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (String(v[i][0]) === id) { sh.deleteRow(i + 1); return true; }
  return false;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ===== Расчёты =====
function calc(now) {
  now = now || new Date();
  const L = limits(), log = readLog();
  const ws = weekStart(now), ds = dayStart(now), ms = monthStart(now);
  const wa = (e) => (isM(e.c) ? e.ov || 0 : e.a); // сколько запись съедает из недельного лимита
  const weekLimit = Object.keys(CATS).reduce((s, c) => s + (isM(c) ? 0 : L[c] || 0), 0);
  const inW = log.filter((e) => e.t >= ws), inD = log.filter((e) => e.t >= ds), inM = log.filter((e) => e.t >= ms);
  const spentW = inW.reduce((s, e) => s + wa(e), 0), spentD = inD.reduce((s, e) => s + wa(e), 0);
  const byW = {}, byM = {};
  Object.keys(CATS).forEach((c) => { byW[c] = 0; byM[c] = 0; });
  inW.forEach((e) => { byW[e.c] = (byW[e.c] || 0) + e.a; });
  inM.forEach((e) => { byM[e.c] = (byM[e.c] || 0) + e.a; });
  const daysLeft = 7 - ((now.getDay() + 6) % 7);
  const leftW = weekLimit - spentW;
  const todayAllow = Math.max(0, (weekLimit - (spentW - spentD)) / daysLeft - spentD);
  const catLeft = (c) => (L[c] || 0) - (isM(c) ? byM[c] : byW[c]);
  const nextMon = new Date(ws); nextMon.setDate(ws.getDate() + 7);
  const nextM = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { now, L, log, inW, inD, inM, spentW, spentD, byW, byM, daysLeft, leftW, todayAllow, catLeft, weekLimit, nextMon, nextM };
}

function judge(a, c, wish) {
  const C = calc(), left = C.catLeft(c);
  if (isM(c)) {
    if (a <= left) return { kind: '✅ Можно', p: [`Лимит «${CATS[c]}» на месяц: после покупки останется ${k(left - a)}.`], acts: ['buy', 'no'] };
    const over = a - Math.max(0, left);
    if (over <= C.leftW) return { kind: '⚠️ Можно, но…', p: [`Месячный лимит «${CATS[c]}» ${left > 0 ? 'остаётся только ' + k(left) : 'уже исчерпан'}. Перерасход ${k(over)} возьмётся из недельного лимита.`, `На другие траты до конца недели останется ${k(Math.max(0, C.leftW - over))}.`], acts: ['buy', 'no'], over };
    return { kind: '❌ Нет', p: [`На одежду в этом месяце осталось ${k(Math.max(0, left))}, а покупка — ${k(a)}.`, `Новый лимит — с ${C.nextM.getDate()} ${MON[C.nextM.getMonth()]}. Можно разделить покупку на два месяца.`], acts: ['wish', 'no'] };
  }
  const matured = wish && Date.now() - wish.t.getTime() >= WAIT_H * 36e5;
  const after = C.leftW - a, perDay = C.daysLeft > 1 ? after / (C.daysLeft - 1) : after;
  if (a > C.leftW) return { kind: '❌ Нет', p: [`На эту неделю осталось ${k(Math.max(0, C.leftW))}, а покупка — ${k(a)}.`, `Новый лимит — с понедельника, ${C.nextMon.getDate()} ${MON[C.nextMon.getMonth()]}.`], acts: a >= BIG ? ['wish', 'no'] : ['no'] };
  if (a >= BIG && !matured) return { kind: '⏳ Подождите 48 часов', p: [`Покупка от ${k(BIG)} — сначала в список желаний.`, 'Через 2 дня я спрошу ещё раз. Если всё ещё нужна — проверим снова.'], acts: ['wish', 'no'] };
  if (a <= left) {
    const p = [`В «${CATS[c]}» на неделю останется ${k(left - a)}.`];
    p.push(a > C.todayAllow ? `Это больше нормы на сегодня (${k(C.todayAllow)}). Дальше будет по ${k(Math.max(0, perDay))} в день.` : `Сегодня после покупки можно ещё ${k(C.todayAllow - a)}.`);
    return { kind: '✅ Можно', p, acts: ['buy', 'no'] };
  }
  return { kind: '⚠️ Можно, но…', p: [`Лимит «${CATS[c]}» на неделю ${left > 0 ? 'почти кончился: осталось ' + k(left) : 'уже исчерпан на ' + k(-left)}.`, `Деньги возьмутся из других категорий: на остаток недели будет ${k(Math.max(0, after))}${C.daysLeft > 1 ? ', это ' + k(Math.max(0, perDay)) + ' в день' : ''}.`], acts: ['buy', 'no'] };
}

function showVerdict(d) {
  const wish = d.wishId ? readWish().find((w) => w.id === d.wishId) : null;
  const v = judge(d.a, d.c, wish);
  if (d.wishId && v.kind.indexOf('❌') < 0) v.acts = ['buy', 'no'];
  d.over = v.over || 0;
  saveDraft(d);
  const btn = { buy: { text: '✅ Купил — записать', callback_data: 'buy' }, wish: { text: '🛍 В список желаний', callback_data: 'wish' }, no: { text: '👍 Не покупаю', callback_data: 'no' } };
  send(`<b>${v.kind}</b>\n${fmt(d.a)} сум · ${CATS[d.c]}${d.n ? ' · ' + esc(d.n) : ''}\n\n${v.p.join('\n')}`, { inline_keyboard: [v.acts.map((a) => btn[a])] });
}

function onCallback(cb) {
  tg('answerCallbackQuery', { callback_query_id: cb.id });
  tg('editMessageReplyMarkup', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  const data = cb.data || '';
  const d = getDraft();
  if (data.indexOf('c:') === 0) {
    if (!d) return send('Не вижу суммы — напишите её ещё раз.');
    d.c = data.slice(2);
    return showVerdict(d);
  }
  if (data === 'buy') {
    if (!d || !d.c) return send('Покупка уже записана или устарела. Напишите сумму ещё раз.');
    addLog({ id: uid(), t: new Date(), a: d.a, c: d.c, n: d.n, ov: d.over || 0 });
    if (d.wishId) deleteRow('Wish', d.wishId);
    CacheService.getScriptCache().remove('draft');
    const C = calc();
    return send(`Записано ✅ ${fmt(d.a)} сум — ${CATS[d.c]}.\nСегодня ещё можно: <b>${k(C.todayAllow)}</b> · на неделю осталось ${k(C.leftW)}.`);
  }
  if (data === 'wish') {
    if (!d) return send('Не вижу покупки — напишите сумму ещё раз.');
    if (!d.wishId) addWish({ id: uid(), t: new Date(), a: d.a, c: d.c, n: d.n });
    CacheService.getScriptCache().remove('draft');
    return send(`Добавил в список желаний. Напомню через ${WAIT_H} часов.`);
  }
  if (data === 'no') {
    CacheService.getScriptCache().remove('draft');
    return send('👍 Отличное решение — деньги остались в плане.');
  }
  if (data.indexOf('rw:') === 0) {
    const w = readWish().find((x) => x.id === data.slice(3));
    if (!w) return send('Этой позиции уже нет в списке.');
    return showVerdict({ a: w.a, c: w.c, n: w.n, wishId: w.id });
  }
  if (data.indexOf('dw:') === 0) {
    deleteRow('Wish', data.slice(3));
    return send('Удалил из списка желаний. Это и есть экономия 💰');
  }
  if (data.indexOf('ul:') === 0) {
    deleteRow('Log', data.slice(3));
    return send('Запись удалена.');
  }
}

// ===== Ответы =====
function todayText() {
  const C = calc();
  const list = C.inD.map((e) => `• ${esc(e.n || CATS[e.c])} — ${k(e.a)}`).join('\n');
  return `<b>Сегодня, ${dayLabel(C.now)}</b>\nМожно ещё: <b>${k(C.todayAllow)}</b>\n` +
    `Неделя: осталось ${k(C.leftW)} из ${k(C.weekLimit)}, дней: ${C.daysLeft}\n` +
    `Одежда: на месяц осталось ${k(C.catLeft('clothes'))}\n\n` +
    (list ? `Траты сегодня (${k(C.spentD)}):\n${list}` : 'Сегодня гибких трат ещё не было.');
}
function weekText(final) {
  const C = calc();
  const cats = Object.keys(CATS).filter((c) => !isM(c)).map((c) => {
    const sp = C.byW[c], lim = C.L[c];
    return `${sp > lim ? '🔴' : sp > lim * 0.8 ? '🟡' : '🟢'} ${CATS[c]}: ${k(sp)} из ${k(lim)}`;
  }).join('\n');
  const top = C.inW.slice().sort((a, b) => b.a - a.a).slice(0, 3).map((e) => `• ${esc(e.n || CATS[e.c])} — ${k(e.a)}`).join('\n');
  const wish = readWish().filter((w) => Date.now() - w.t.getTime() >= WAIT_H * 36e5);
  let t = `<b>${final ? 'Итог недели' : 'Неделя'}</b>\nПотрачено ${k(C.spentW)} из ${k(C.weekLimit)}` +
    (final ? (C.leftW >= 0 ? ` — в копилку ${k(C.leftW)} 💰` : ` — перерасход ${k(-C.leftW)}`) : `, осталось ${k(C.leftW)}`) +
    `\n\n${cats}\n👕 Одежда за месяц: ${k(C.byM.clothes)} из ${k(C.L.clothes)}`;
  if (top) t += `\n\nКрупные траты:\n${top}`;
  if (wish.length) t += `\n\n🛍 Можно решать: ${wish.map((w) => esc(w.n || CATS[w.c]) + ' (' + k(w.a) + ')').join(', ')}`;
  if (final && !C.inW.length) t += '\n\nЗаписей за неделю нет. Выгружайте MoneyLover вечером — я внесу траты сам.';
  return t;
}
function showWish() {
  const W = readWish();
  if (!W.length) return send('Список желаний пуст.');
  W.forEach((w) => {
    const h = Math.max(0, WAIT_H - (Date.now() - w.t.getTime()) / 36e5);
    send(`🛍 <b>${esc(w.n || CATS[w.c])}</b> — ${k(w.a)}\n${CATS[w.c]} · ${h > 0 ? 'ещё ' + Math.ceil(h) + ' ч' : 'можно решать'}`,
      { inline_keyboard: [[...(h > 0 ? [] : [{ text: 'Проверить снова', callback_data: 'rw:' + w.id }]), { text: '✕ Удалить', callback_data: 'dw:' + w.id }]] });
  });
}
function showLimits() {
  const L = limits();
  send('<b>Лимиты</b>\n' + Object.keys(CATS).map((c) => `${CATS[c]} (${c}): ${k(L[c])} ${isM(c) ? 'в месяц' : 'в неделю'}`).join('\n') +
    '\n\nИзменить: <b>/limit cafe 400000</b>');
}
function setLimit(text) {
  const m = text.match(/^\/limit\s+(\w+)\s+([\d\s]+)/);
  if (!m || !CATS[m[1]]) return send('Формат: <b>/limit cafe 400000</b>. Ключи: ' + Object.keys(CATS).join(', '));
  const L = JSON.parse(P('LIMITS') || '{}');
  L[m[1]] = +m[2].replace(/\s/g, '');
  props().setProperty('LIMITS', JSON.stringify(L));
  showLimits();
}
function undo() {
  const log = readLog().filter((e) => !e.src);
  const last = log[log.length - 1];
  if (!last) return send('Нет ручных записей для удаления.');
  send(`Удалить последнюю запись: ${esc(last.n || CATS[last.c])} — ${fmt(last.a)} сум?`, { inline_keyboard: [[{ text: 'Удалить', callback_data: 'ul:' + last.id }, { text: 'Оставить', callback_data: 'no' }]] });
}

// ===== MoneyLover =====
function findExport(since, coverDate) {
  const q = `title contains 'MoneyLover' and title contains 'Пластик' and mimeType = 'application/vnd.google-apps.spreadsheet' and modifiedDate > '${Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss")}' and trashed = false`;
  const it = DriveApp.searchFiles(q);
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    const r = f.getName().match(/(\d{2})\/(\d{2})\/(\d{4})-(\d{2})\/(\d{2})\/(\d{4})/);
    if (r && coverDate) {
      const from = new Date(+r[3], +r[2] - 1, +r[1]), to = new Date(+r[6], +r[5] - 1, +r[4]);
      if (coverDate < from || coverDate > to) continue;
    }
    if (!best || f.getDateCreated() > best.getDateCreated()) best = f;
  }
  return best;
}
function readExport(file) {
  const ss = SpreadsheetApp.open(file);
  const sh = ss.getSheetByName('Операции') || ss.getSheets()[0];
  const range = sh.getDataRange();
  const v = range.getDisplayValues(), raw = range.getValues();
  const h = v[0];
  const col = (name) => h.findIndex((x) => String(x).indexOf(name) === 0);
  const iD = col('Дата'), iC = col('Категория'), iS = col('Сумма'), iN = col('Примечание'), iX = col('Исключить');
  return v.slice(1).map((r, i) => {
    const rd = raw[i + 1][iD], rs = raw[i + 1][iS];
    let d = null;
    if (rd instanceof Date) d = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate());
    else {
      const dm = String(r[iD]).match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
      if (dm) d = new Date(+dm[3], +dm[2] - 1, +dm[1]);
    }
    const s = typeof rs === 'number' ? rs : parseFloat(String(rs).replace(/[\s ]/g, '').replace('−', '-').replace(',', '.'));
    return d ? { d, ds: Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy'), cat: String(r[iC]).trim(), s, note: String(r[iN] || '').trim(), excl: iX >= 0 && String(r[iX]).trim() !== '' } : null;
  }).filter((r) => r && !r.excl && r.s < 0).map((r) => Object.assign(r, { a: -r.s }));
}
function flexCat(r) {
  const n = r.note.toLowerCase(), c = r.cat;
  if (c === 'Кийим') return 'clothes';
  if (['Uzum', 'Pinduoduo', 'Wb'].indexOf(c) >= 0) return 'market';
  if (c === 'Питание' && CAFE_RE.test(n)) return 'cafe';
  if (['Личные предметы', 'Iphone', 'Apple', 'Steam Игры', 'Meta Quest', 'Телеграмм'].indexOf(c) >= 0 || n.indexOf('дух') >= 0) return 'misc';
  if (c === 'Питание' && r.a < 60000) return 'misc';
  if (['Наличка', 'Такси', 'Развлечения', 'Прочие расходы', 'Предметы быта', 'Домашние расходы'].indexOf(c) >= 0) return 'cash';
  return null;
}

/** Забирает сегодняшний экспорт и вносит гибкие траты за последние 7 дней. */
function importMoneyLover() {
  const now = new Date(), today = dayStart(now);
  const file = findExport(today, today);
  if (!file) return { found: false };
  const rows = readExport(file);
  const from = new Date(today); from.setDate(from.getDate() - 6);
  const log = readLog(), keys = {}, seen = {};
  log.forEach((e) => { if (e.key) keys[e.key] = 1; });
  const L = limits();
  let clothesM = log.filter((e) => e.c === 'clothes' && e.t >= monthStart(now)).reduce((s, e) => s + e.a, 0);
  const added = [];
  rows.filter((r) => r.d >= from && r.d <= now).forEach((r) => {
    const c = flexCat(r);
    if (!c) return;
    const base = [r.ds, r.cat, r.a, r.note].join('|');
    seen[base] = (seen[base] || 0) + 1;
    const key = base + '|' + seen[base];
    if (keys[key]) return;
    const manual = log.find((e) => !e.src && e.c === c && e.a === r.a && dayStart(e.t).getTime() === r.d.getTime());
    if (manual) { keys[key] = 1; return; }
    let ov = 0;
    if (c === 'clothes') {
      const was = Math.max(0, clothesM - L.clothes);
      clothesM += r.a;
      ov = Math.max(0, clothesM - L.clothes) - was;
    }
    const t = new Date(r.d); t.setHours(20, 0, 0, 0);
    const e = { id: 'ml' + uid(), t, a: r.a, c, n: r.note || r.cat, src: 'ml', key, ov };
    addLog(e);
    added.push(e);
  });
  const C = calc();
  const todayAdded = added.filter((e) => e.t >= today);
  const warn = Object.keys(CATS).filter((c) => C.catLeft(c) < 0).map((c) => `⚠️ ${CATS[c]}: превышение ${k(-C.catLeft(c))}`);
  const text = `<b>Итог дня, ${dayLabel(now)}</b>\n` +
    `Гибкие траты сегодня: ${k(C.spentD)}${todayAdded.length ? ' (' + todayAdded.map((e) => esc(e.n) + ' ' + k(e.a)).join(', ') + ')' : ''}\n` +
    `Неделя: осталось ${k(C.leftW)} из ${k(C.weekLimit)}${C.daysLeft > 1 ? ' — ' + k(Math.max(0, C.leftW) / (C.daysLeft - 1)) + ' в день до воскресенья' : ''}\n` +
    `Одежда: на месяц осталось ${k(C.catLeft('clothes'))}` +
    (warn.length ? '\n' + warn[0] : '') +
    (added.length ? `\n\nДобавлено записей: ${added.length}` : '');
  return { found: true, text, added: added.length };
}

/** Итог прошлого месяца по 13 статьям плана экономии. */
function monthText(now) {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1), last = new Date(now.getFullYear(), now.getMonth(), 0);
  const file = findExport(new Date(now.getFullYear(), now.getMonth() - 1, 1), last);
  if (!file) return `Экспорт MoneyLover за ${MON_N[first.getMonth()]} на Диске не найден. Выгрузите период за весь прошлый месяц — и напишите /month.`;
  const sum = {};
  PLAN.forEach((p) => { sum[p[0]] = 0; });
  readExport(file).filter((r) => r.d >= first && r.d <= last).forEach((r) => {
    const n = r.note.toLowerCase(), c = r.cat;
    let key = null;
    if (n.indexOf('дух') >= 0) key = 'perfume';
    else if (c === 'Стоянка' || /парков|стоянк/.test(n)) key = 'park';
    else if (['Apple', 'Телеграмм', 'Steam Игры', 'Meta Quest'].indexOf(c) >= 0 || /claude|sider|\bии\b| ai|vpn|github|иви|подписк|яндекс/.test(n)) key = 'subs';
    else if (c === 'Наличка') key = 'cash';
    else if (c === 'Кийим') key = 'clothes';
    else if (['Uzum', 'Pinduoduo', 'Wb'].indexOf(c) >= 0) key = 'market';
    else if (c === 'Корзинка') key = 'food';
    else if (c === 'Питание' && CAFE_RE.test(n)) key = 'cafe';
    else if (c === 'Питание' && r.a < 60000) key = 'snacks';
    else if (['Личные предметы', 'Iphone'].indexOf(c) >= 0) key = 'gadgets';
    else if (c === 'Транспорт' && !/страховк|замена масла/.test(n)) key = 'car';
    else if (c === 'Счет за телефон') key = 'phone';
    else if (c === 'Штраф') key = 'fines';
    if (key) sum[key] += r.a / 1e6;
  });
  let saved = 0;
  const goal = PLAN.reduce((s, p) => s + p[2] - p[3], 0);
  const lines = PLAN.map(([key, name, base, target]) => {
    const f = sum[key];
    saved += base - f;
    return `${f <= target + 1e-9 ? '🟢' : f <= base ? '🟡' : '🔴'} ${name}: ${f.toFixed(2).replace('.', ',')} (цель ${target.toFixed(2).replace('.', ',')})`;
  });
  return `<b>Итог месяца: ${MON_N[first.getMonth()]} ${first.getFullYear()}</b>\n` +
    `Экономия против прошлого года: <b>${saved.toFixed(2).replace('.', ',')} млн</b> (${(saved / EXPENSES * 100).toFixed(1).replace('.', ',')}% расходов), цель ${goal.toFixed(2).replace('.', ',')} млн ${saved >= goal ? '✅' : '—'}\n\n` +
    lines.join('\n') + '\n\nВсе суммы — млн сум.';
}

// ===== Расписание =====
function dailyReminder() {
  send('📤 Выгрузите MoneyLover на Диск: «Пластик» → Экспорт → «Этот месяц» → Google Диск. В 21:30 я внесу траты и пришлю итог.');
}
function dailyImport() {
  const r = importMoneyLover();
  if (r.found) send(r.text); // без выгрузки — молчим
}
function weeklySummary() { send(weekText(true)); }
function monthlySummary() { send(monthText(new Date())); }
function wishReminder() {
  const due = readWish().filter((w) => {
    const age = (Date.now() - w.t.getTime()) / 36e5;
    return age >= WAIT_H && age < WAIT_H + 1;
  });
  due.forEach((w) => send(`⏰ Прошло 48 часов: <b>${esc(w.n || CATS[w.c])}</b> — ${k(w.a)}. Всё ещё нужно?`,
    { inline_keyboard: [[{ text: 'Проверить снова', callback_data: 'rw:' + w.id }, { text: '✕ Уже не нужно', callback_data: 'dw:' + w.id }]] }));
}

/**
 * Запустите один раз после развёртывания веб-приложения:
 * создаёт таблицу данных, ставит вебхук и расписание.
 */
function setup() {
  if (!P('TOKEN')) throw new Error('Сначала добавьте TOKEN в «Свойства скрипта» (Настройки проекта).');
  if (!P('SECRET')) props().setProperty('SECRET', Utilities.getUuid().replace(/-/g, ''));
  sheet('Log'); sheet('Wish');
  const url = ScriptApp.getService().getUrl();
  if (!url) throw new Error('Сначала разверните проект как веб-приложение (Развернуть → Новое развертывание → Веб-приложение).');
  const r = tg('setWebhook', { url: url + '?k=' + P('SECRET'), drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] });
  console.log('setWebhook:', JSON.stringify(r));
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(21).nearMinute(0).create();
  ScriptApp.newTrigger('dailyImport').timeBased().everyDays(1).atHour(21).nearMinute(30).create();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).nearMinute(45).create();
  ScriptApp.newTrigger('monthlySummary').timeBased().onMonthDay(2).atHour(10).create();
  ScriptApp.newTrigger('wishReminder').timeBased().everyHours(1).create();
  console.log('Готово. Откройте бота в Telegram и нажмите /start.');
}
