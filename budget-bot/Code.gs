/**
 * Бюджет-бот: проверка покупок перед тратой, учёт гибких трат,
 * импорт экспорта MoneyLover с Google Диска и итоги в Telegram.
 * Работает целиком в Google Apps Script, без своего сервера.
 * Инструкция по установке — в README.md рядом.
 */

// ===== Настройки =====
const CATS = {
  cafe: 'Питание',
  market: 'Маркетплейсы',
  other: 'Прочее',
  family: 'Ужин с семьёй',
  clothes: 'Одежда',
  gadgets: 'Гаджеты и вещи',
  subs: 'Подписки',
  perfume: 'Духи',
  cash: 'Снятие наличных',
};
const DEFAULT_LIMITS = { cafe: 800000, market: 380000, other: 250000, family: 1500000, clothes: 2500000, gadgets: 600000, subs: 500000, perfume: 600000, cash: 4000000 };
// Период лимита: m — месяц, m2 — два месяца (янв–фев, мар–апр, …). Остальные — неделя.
const PERIOD = { family: 'm', clothes: 'm', gadgets: 'm', subs: 'm', cash: 'm', perfume: 'm2' };
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

// «Питание» делим по примечаниям на группы. Пустое примечание — обед.
const RULES_VERSION = '2026-10-27-limits'; // при смене правил бот пересчитывает всё заново
function foodGroup(note) {
  const n = String(note || '').toLowerCase().trim();
  if (!n) return 'Обед';
  if (/семь|оила/.test(n)) return 'Ужин с семьёй';
  if (/пив|водк|вино|коньяк|виски|алко|шампан/.test(n)) return 'Алкоголь';
  if (/сигар|iqos|айкос|вейп|табак/.test(n)) return 'Сигареты';
  if (/гушт|мяс|уйга|домой|продукт|бозор|базар|курица|тову?қ/.test(n)) return 'Домой';
  if (/торт|шоколад|конфет|сладк|десерт|морожен/.test(n)) return 'Сладкое';
  return 'Кафе/еда';
}
// «Питание» — недельный лимит, кроме ужинов с семьёй: у них свой лимит на месяц.
// Отдельные категории MoneyLover, которые сразу считаются «Кафе и алкоголь»
const CAFE_CATS = ['Кафе', 'Ресторан', 'Рестораны', 'Кафе и рестораны', 'Алкоголь', 'Пиво', 'Фастфуд'];
const CAFE_RE = /пив|водк|шашлык|бургер|ужин|обед|норин|калла|лаваш|сомса|safia|evos|евос|kfc|kfs|торт|сигар|кафе|ресторан/i;
const KEYBOARD = {
  keyboard: [[{ text: '📊 Сегодня' }, { text: '📅 Неделя' }], [{ text: '🛍 Список желаний' }, { text: '⚙️ Лимиты' }], [{ text: '📈 Расходы' }, { text: '💰 Доходы' }], [{ text: '📥 Импорт MoneyLover' }, { text: '✏️ Изменить лимит' }]],
  resize_keyboard: true,
  is_persistent: true,
};

// ===== Служебное =====
const props = () => PropertiesService.getScriptProperties();
const P = (k) => props().getProperty(k);
const owner = () => P('OWNER_CHAT_ID');
const limits = () => Object.assign({}, DEFAULT_LIMITS, JSON.parse(P('LIMITS') || '{}'));
const isM = (c) => !!PERIOD[c];
const perLabel = (c) => (PERIOD[c] === 'm2' ? 'на 2 месяца' : PERIOD[c] ? 'в месяц' : 'в неделю');
const perShort = (c) => (PERIOD[c] === 'm2' ? '/2 мес' : PERIOD[c] ? '/мес' : '/нед');
/** Начало текущего периода лимита (для месячных и двухмесячных). */
function periodStart(c, d) {
  return PERIOD[c] === 'm2' ? new Date(d.getFullYear(), d.getMonth() - (d.getMonth() % 2), 1) : monthStart(d);
}
function nextPeriod(c, d) {
  const s = periodStart(c, d);
  return new Date(s.getFullYear(), s.getMonth() + (PERIOD[c] === 'm2' ? 2 : 1), 1);
}

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
  const r = tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_markup: markup || KEYBOARD, disable_web_page_preview: true });
  if (!r.ok) {
    console.error('sendMessage: ' + JSON.stringify(r));
    tg('sendMessage', { chat_id: chat, text: text.replace(/<[^>]+>/g, ''), reply_markup: markup || KEYBOARD });
  }
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
    try { send('⚠️ Ошибка в боте: ' + esc(err && err.message || err) + '\nПришлите этот текст Claude.'); } catch (e2) { console.error(e2); }
  }
  return ok();
}
function doGet() { return ok(); }

/**
 * Забирает новые сообщения из Telegram (запускается раз в минуту).
 * Вебхук Google Apps Script отвечает Telegram переадресацией 302, из-за этого
 * Telegram «вешает» очередь, поэтому бот сам опрашивает Telegram.
 */
function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    if (P('RULES') !== RULES_VERSION) { props().deleteProperty('LIMITS'); resetData(true); }
    if (Date.now() - (+P('LAST_CLEAN') || 0) > 7 * 864e5) {
      const n = cleanupExports();
      if (n) send(`🧹 Убрал в корзину ${n} старых экспортов MoneyLover. Оставил годовой и последний за каждый месяц.`);
    }
    let offset = +P('OFFSET') || 0;
    const r = tg('getUpdates', { offset, timeout: 0, limit: 20, allowed_updates: ['message', 'callback_query'] });
    if (!r.ok) { console.error('getUpdates: ' + JSON.stringify(r)); return; }
    r.result.forEach((u) => {
      offset = u.update_id + 1;
      props().setProperty('OFFSET', String(offset)); // сначала сдвигаем, чтобы сбойное сообщение не повторялось
      try { handle(u); } catch (err) {
        console.error(err && err.stack || err);
        try { send('⚠️ Ошибка в боте: ' + esc(err && err.message || err) + '\nПришлите этот текст Claude.'); } catch (e2) { console.error(e2); }
      }
    });
  } finally { lock.releaseLock(); }
}
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
  if (/^✏️/.test(text)) return chooseLimit();
  if (/^\/limit\s+/.test(text)) return setLimit(text);
  if (/^\/undo/.test(text)) return undo();
  if (/^\/reset/.test(text)) return resetData(true);
  if (/^\/clean/.test(text)) { const n = cleanupExports(); return send(n ? `🧹 Убрал в корзину ${n} старых экспортов MoneyLover.` : 'Лишних экспортов нет 👍'); }
  if (/^\/import|^📥/.test(text)) { send('⏳ Забираю экспорт MoneyLover с Диска…'); const r = importMoneyLover(); return send(r.found ? r.text : 'Сегодняшний экспорт MoneyLover на Диске не найден.'); }
  if (/^\/month/.test(text)) return send(monthText(new Date()));
  if (/^\/expenses|^📈/.test(text)) { send('⏳ Считаю расходы за 3 месяца…'); return [].concat(expensesText()).forEach((m) => send(m)); }
  if (/^\/income|^💰/.test(text)) { send('⏳ Считаю доходы за 3 месяца…'); return send(incomeText()); }

  const editing = CacheService.getScriptCache().get('editLimit');
  if (editing && true) {
    CacheService.getScriptCache().remove('editLimit');
    const v = parseAmount(text);
    if (!v) return send('Не понял сумму. Нажмите ✏️ Изменить лимит ещё раз.');
    return saveLimit(editing, v.a);
  }
  const parsed = parseAmount(text);
  if (!parsed) return send('Напишите сумму и, по желанию, что покупаете. Например: <b>150000 обед</b> или <b>1,2 млн наушники</b>. /help — все команды.');
  const draft = { a: parsed.a, n: parsed.note, c: guessCat(parsed.note) };
  saveDraft(draft);
  if (!draft.c) return askCategory(draft);
  showVerdict(draft);
}

function welcome() {
  send('Привет! Я ваш бюджет-бот. Отвечаю в течение минуты.\n\n' +
    '• Перед покупкой напишите сумму, например <b>150000 обед</b>, и я скажу, можно ли.\n' +
    '• В 21:00 напомню выгрузить MoneyLover на Диск, в 21:30 сам внесу траты и пришлю итог дня.\n' +
    '• В воскресенье — итог недели, 2-го числа — итог месяца по плану экономии.\n\n/help — все команды.');
}
function help() {
  send('<b>Команды</b>\n' +
    '<b>150000 обед</b> — проверить покупку\n' +
    '/today — сегодня\n/week — неделя\n/wish — список желаний\n' +
    '/limits — лимиты\n✏️ Изменить лимит — кнопка в меню\n' +
    '/import — забрать экспорт MoneyLover сейчас\n/clean — убрать старые экспорты в корзину\n/reset — пересчитать всё заново\n/month — итог месяца по плану\n/expenses — расходы за 3 месяца\n/income — доходы за 3 месяца\n\n' +
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
  if (/семь|оила/.test(s)) return 'family';
  if (/дух|парфюм/.test(s)) return 'perfume';
  if (CAFE_RE.test(s) || /перекус|кофе|шоколад/.test(s)) return 'cafe';
  if (/uzum|узум|wb|wildberries|pinduoduo|маркет|озон|ozon/.test(s)) return 'market';
  if (/одежд|кийим|обув|куртк|штан|платье|футболк|костюм/.test(s)) return 'clothes';
  if (/подписк|apple|icloud|telegram|телеграм|claude|vpn/.test(s)) return 'subs';
  if (/наушник|часы|гаджет|чехол|телефон|airpods|сумк/.test(s)) return 'gadgets';
  if (/налич|снять|банкомат/.test(s)) return 'cash';
  if (/такси|кино|развлеч|подарок|быт/.test(s)) return 'other';
  return null;
}
function saveDraft(d) { CacheService.getScriptCache().put('draft', JSON.stringify(d), 3600); }
function getDraft() { return JSON.parse(CacheService.getScriptCache().get('draft') || 'null'); }

function askCategory(d) {
  const C = calc();
  const rows = Object.keys(CATS).map((c) => [{ text: `${CATS[c]} · ${k(C.catLeft(c))}${perShort(c)}`, callback_data: 'c:' + c }]);
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
    const head = name === 'История' ? ['месяц', 'тип', 'категория', 'примечание', 'сумма'] : name === 'Log' ? ['id', 'время', 'сумма', 'категория', 'примечание', 'источник', 'ключ', 'сверх лимита'] : ['id', 'время', 'сумма', 'категория', 'примечание'];
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
  const L = limits(), log = readLog().filter((e) => e.src === 'ml'); // считаем только то, что пришло из MoneyLover
  const ws = weekStart(now), ds = dayStart(now), ms = monthStart(now);
  const wa = (e) => (isM(e.c) ? e.ov || 0 : e.a); // сколько запись съедает из недельного лимита
  const weekLimit = Object.keys(CATS).reduce((s, c) => s + (isM(c) ? 0 : L[c] || 0), 0);
  const inW = log.filter((e) => e.t >= ws), inD = log.filter((e) => e.t >= ds), inM = log.filter((e) => e.t >= ms);
  const spentW = inW.reduce((s, e) => s + wa(e), 0), spentD = inD.reduce((s, e) => s + wa(e), 0);
  const byW = {}, byM = {};
  Object.keys(CATS).forEach((c) => { byW[c] = 0; byM[c] = isM(c) ? prevPart(c, now) : 0; });
  inW.forEach((e) => { byW[e.c] = (byW[e.c] || 0) + e.a; });
  log.forEach((e) => { if (isM(e.c) && e.t >= periodStart(e.c, now)) byM[e.c] += e.a; }); // byM — за период лимита
  const daysLeft = 7 - ((now.getDay() + 6) % 7);
  const leftW = weekLimit - spentW;
  const todayAllow = Math.max(0, (weekLimit - (spentW - spentD)) / daysLeft - spentD);
  const catLeft = (c) => (L[c] || 0) - (isM(c) ? byM[c] : byW[c]);
  const nextMon = new Date(ws); nextMon.setDate(ws.getDate() + 7);
  const nextM = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { now, L, log, inW, inD, inM, spentW, spentD, byW, byM, daysLeft, leftW, todayAllow, catLeft, weekLimit, nextMon, nextM };
}
/**
 * Траты двухмесячного лимита в прошлом месяце (если период начался в прошлом месяце).
 * Экспорт MoneyLover — за текущий месяц, поэтому прошлый берём из итогов месяца (лист История).
 */
const PREV_MEMO = {};
function prevPart(c, now) {
  const ps = periodStart(c, now), ms = monthStart(now);
  if (ps >= ms) return 0;
  const key = c + ym(ps);
  if (PREV_MEMO[key] === undefined) {
    let sum = 0;
    try {
      const t = monthTotals(ps);
      if (t && c === 'perfume') Object.keys(t.exp).forEach((cat) => Object.keys(t.exp[cat].notes).forEach((n) => { if (/дух/i.test(n)) sum += t.exp[cat].notes[n]; }));
    } catch (e) { console.error(e); }
    PREV_MEMO[key] = sum;
  }
  return PREV_MEMO[key];
}
/** Строки по лимитам на месяц / 2 месяца: сколько осталось. */
function periodLines(C) {
  return Object.keys(CATS).filter(isM).map((c) => {
    const left = C.catLeft(c);
    return `${left < 0 ? '🔴' : left < C.L[c] * 0.2 ? '🟡' : '🟢'} ${CATS[c]}: ${left < 0 ? 'перерасход ' + k(-left) : 'осталось ' + k(left)} из ${k(C.L[c])} ${perLabel(c)}`;
  }).join('\n');
}

function judge(a, c, wish) {
  const C = calc(), left = C.catLeft(c);
  if (isM(c)) {
    const np = nextPeriod(c, C.now), per = PERIOD[c] === 'm2' ? 'за эти 2 месяца' : 'в этом месяце';
    if (a <= left) return { kind: '✅ Можно', p: [`Лимит «${CATS[c]}» ${perLabel(c)}: после покупки останется ${k(left - a)}.`], acts: ['buy', 'no'] };
    const over = a - Math.max(0, left);
    if (over <= C.leftW) return { kind: '⚠️ Можно, но…', p: [`Лимит «${CATS[c]}» ${left > 0 ? 'почти кончился: осталось ' + k(left) : 'уже исчерпан'}. Перерасход ${k(over)} возьмётся из недельного лимита.`, `На другие траты до конца недели останется ${k(Math.max(0, C.leftW - over))}.`], acts: ['buy', 'no'], over };
    return { kind: '❌ Нет', p: [`На «${CATS[c]}» ${per} осталось ${k(Math.max(0, left))}, а покупка — ${k(a)}.`, `Новый лимит — с ${np.getDate()} ${MON[np.getMonth()]}.`], acts: ['wish', 'no'] };
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
  saveDraft(d);
  const acts = [];
  if (d.wishId) acts.push({ text: '✕ Убрать из списка', callback_data: 'dw:' + d.wishId });
  else if (v.acts.indexOf('wish') >= 0) acts.push({ text: '🛍 В список желаний', callback_data: 'wish' });
  send(`<b>${v.kind}</b>\n${fmt(d.a)} сум · ${CATS[d.c]}${d.n ? ' · ' + esc(d.n) : ''}\n\n${v.p.join('\n')}` +
    `\n\n<i>Это совет — ничего не записано. Если купите, запишите трату в MoneyLover; лимиты пересчитаются после импорта 📥. ${lastImportLine()}</i>`,
    acts.length ? { inline_keyboard: [acts] } : undefined);
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
    return send('Теперь бот только советует. Покупку записывайте в MoneyLover — лимиты пересчитаются после импорта 📥.');
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
  if (data.indexOf('el:') === 0) {
    const c = data.slice(3);
    if (!CATS[c]) return;
    CacheService.getScriptCache().put('editLimit', c, 600);
    return send(`«${CATS[c]}» сейчас: <b>${k(limits()[c])}</b> ${perLabel(c)}.\nНапишите новую сумму, например <b>900000</b> или <b>1,2 млн</b>.`,
      { inline_keyboard: [[{ text: 'Отмена', callback_data: 'elx' }]] });
  }
  if (data === 'elx') {
    CacheService.getScriptCache().remove('editLimit');
    return send('Лимит не изменён.');
  }
  if (data.indexOf('ul:') === 0) {
    deleteRow('Log', data.slice(3));
    return send('Запись удалена.');
  }
}

// ===== Ответы =====
function lastImportLine() {
  const t = +P('LAST_IMPORT');
  if (!t) return 'Импорта MoneyLover ещё не было — нажмите 📥.';
  const d = new Date(t);
  return `Данные MoneyLover на ${d.getDate()} ${MON[d.getMonth()]}, ${Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm')}.`;
}
function todayText() {
  const C = calc();
  const list = C.inD.map((e) => `• ${esc(e.n || CATS[e.c])} — ${k(e.a)}`).join('\n');
  return `<b>Сегодня, ${dayLabel(C.now)}</b>\nМожно ещё: <b>${k(C.todayAllow)}</b>\n` +
    `Неделя: осталось ${k(C.leftW)} из ${k(C.weekLimit)}, дней: ${C.daysLeft}\n` +
    periodLines(C) + '\n\n' +
    (list ? `Траты сегодня (${k(C.inD.reduce((a, e) => a + e.a, 0))}):\n${list}` : 'Сегодня гибких трат в MoneyLover ещё нет.') + '\n\n<i>' + lastImportLine() + '</i>';
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
    `\n\n${cats}\n\n<b>Лимиты на месяц:</b>\n${periodLines(C)}`;
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
  send('<b>Лимиты</b>\n' + Object.keys(CATS).map((c) => `${CATS[c]}: ${k(L[c])} ${perLabel(c)}`).join('\n') +
    '\n\nИзменить — кнопка <b>✏️ Изменить лимит</b>.');
}
function setLimit(text) {
  const m = text.match(/^\/limit\s+(\w+)\s+([\d\s]+)/);
  if (!m || !CATS[m[1]]) return send('Формат: <b>/limit cafe 400000</b>. Ключи: ' + Object.keys(CATS).join(', '));
  saveLimit(m[1], +m[2].replace(/\s/g, ''));
}
function saveLimit(c, v) {
  const L = JSON.parse(P('LIMITS') || '{}');
  L[c] = v;
  props().setProperty('LIMITS', JSON.stringify(L));
  send(`✅ Лимит «${CATS[c]}»: <b>${k(v)}</b> ${perLabel(c)}.`);
  showLimits();
}
/** Кнопки выбора лимита для изменения. */
function chooseLimit() {
  const L = limits();
  const rows = Object.keys(CATS).map((c) => [{ text: `${CATS[c]} · ${k(L[c])}${perShort(c)}`, callback_data: 'el:' + c }]);
  send('Какой лимит изменить?', { inline_keyboard: rows });
}
function undo() {
  const log = readLog().filter((e) => !e.src);
  const last = log[log.length - 1];
  if (!last) return send('Нет ручных записей для удаления.');
  send(`Удалить последнюю запись: ${esc(last.n || CATS[last.c])} — ${fmt(last.a)} сум?`, { inline_keyboard: [[{ text: 'Удалить', callback_data: 'ul:' + last.id }, { text: 'Оставить', callback_data: 'no' }]] });
}

// ===== MoneyLover =====
function findExport(since, coverDate) {
  const q = `title contains 'MoneyLover' and (title contains 'Пластик' or title contains 'Итого') and mimeType = 'application/vnd.google-apps.spreadsheet' and modifiedDate > '${Utilities.formatDate(since, 'UTC', "yyyy-MM-dd'T'HH:mm:ss")}' and trashed = false`;
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
  return readExportAll(file).filter((r) => r.s < 0).map((r) => Object.assign(r, { a: -r.s }));
}
const EXPORT_MEMO = {}; // в рамках одного запуска не читаем один и тот же экспорт дважды
function readExportAll(file) {
  const id = file.getId ? file.getId() : file.getName() + file.getDateCreated();
  if (!EXPORT_MEMO[id]) EXPORT_MEMO[id] = readExportAllRaw(file);
  return EXPORT_MEMO[id].map((r) => Object.assign({}, r));
}
function readExportAllRaw(file) {
  const ss = SpreadsheetApp.open(file);
  const sh = ss.getSheetByName('Операции') || ss.getSheets()[0];
  const range = sh.getDataRange();
  const v = range.getDisplayValues(), raw = range.getValues();
  const h = v[0];
  const col = (name) => h.findIndex((x) => String(x).indexOf(name) === 0);
  const iD = col('Дата'), iC = col('Категория'), iS = col('Сумма'), iN = col('Примечание'), iX = col('Исключить'), iW = col('Кошел');
  // Экспорт «Итого» — все кошельки. Снятие наличных с карты (категория «Наличка») считаем расходом,
  // а траты из кошелька «Наличка» — отдельно, только для справки (иначе деньги посчитаются дважды).
  return v.slice(1).map((r, i) => {
    const rd = raw[i + 1][iD], rs = raw[i + 1][iS];
    let d = null;
    if (rd instanceof Date) d = new Date(rd.getFullYear(), rd.getMonth(), rd.getDate());
    else {
      const dm = String(r[iD]).match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
      if (dm) d = new Date(+dm[3], +dm[2] - 1, +dm[1]);
    }
    const s = typeof rs === 'number' ? rs : parseFloat(String(rs).replace(/[\s ]/g, '').replace('−', '-').replace(',', '.'));
    const cat = String(r[iC]).trim();
    return d ? { d, ds: Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy'), cat, s, note: String(r[iN] || '').trim(), wallet: iW >= 0 ? String(r[iW]).trim() : '', cashWallet: iW >= 0 && String(r[iW]).trim() === 'Наличка', excl: iX >= 0 && String(r[iX]).trim() !== '' } : null;
  }).filter((r) => r && !r.excl && isFinite(r.s));
}
function flexCat(r) {
  if (r.cashWallet) return null; // траты из кошелька «Наличка» уже посчитаны снятием наличных
  const n = r.note.toLowerCase(), c = r.cat;
  if (n.indexOf('дух') >= 0 && c !== 'Питание') return 'perfume';
  if (c === 'Наличка') return 'cash';
  if (c === 'Кийим') return 'clothes';
  if (['Uzum', 'Pinduoduo', 'Wb'].indexOf(c) >= 0) return 'market';
  if (CAFE_CATS.indexOf(c) >= 0 || c === 'Питание') return foodGroup(r.note) === 'Ужин с семьёй' ? 'family' : 'cafe';
  if (['Apple', 'Телеграмм', 'Steam Игры', 'Meta Quest'].indexOf(c) >= 0) return 'subs';
  if (c === 'Другие счета' && /claude|sider|\bии\b|\bai\b|vpn|подписк/.test(n)) return 'subs';
  if (['Личные предметы', 'Iphone'].indexOf(c) >= 0) return 'gadgets';
  if (['Такси', 'Развлечения', 'Прочие расходы', 'Предметы быта', 'Домашние расходы'].indexOf(c) >= 0) return 'other';
  return null;
}

/** Забирает сегодняшний экспорт и вносит гибкие траты с начала месяца (и минимум за 7 дней). */
/** Новые правила: стираем расчёты бота и пересчитываем из MoneyLover. */
function resetData(announce) {
  props().setProperty('RULES', RULES_VERSION);
  const log = sheet('Log');
  if (log.getLastRow() > 1) log.deleteRows(2, log.getLastRow() - 1);
  const hist = sheet('История');
  if (hist.getLastRow() > 1) hist.deleteRows(2, hist.getLastRow() - 1);
  props().deleteProperty('LAST_IMPORT');
  const r = importMoneyLover(true);
  if (announce) send('🔄 Правила обновлены — пересчитал всё заново.' + (r.found ? '\n\n' + r.text : '\nЭкспорт MoneyLover не найден — нажмите 📥 после выгрузки.'));
}
function importMoneyLover(anyRecent) {
  const now = new Date(), today = dayStart(now);
  const file = findExport(anyRecent ? new Date(now.getTime() - 40 * 864e5) : today, today);
  if (!file) return { found: false };
  const rows = readExport(file);
  const from = new Date(Math.min(monthStart(now).getTime(), today.getTime() - 6 * 864e5)); // весь месяц — для месячных лимитов
  const log = readLog(), keys = {}, seen = {};
  log.forEach((e) => { if (e.key) keys[e.key] = 1; });
  const L = limits();
  // сколько уже потрачено в текущем периоде месячных лимитов — чтобы отметить перерасход
  const run = {};
  Object.keys(PERIOD).forEach((c) => { run[c] = prevPart(c, now) + log.filter((e) => e.c === c && e.t >= periodStart(c, now)).reduce((s, e) => s + e.a, 0); });
  const added = [];
  rows.filter((r) => r.d >= from && r.d <= now).forEach((r) => {
    const c = flexCat(r);
    if (!c) return;
    const base = [r.ds, r.cat, r.a, r.note].join('|');
    seen[base] = (seen[base] || 0) + 1;
    const key = base + '|' + seen[base];
    if (keys[key]) return;
    // ручная запись в боте того же дня и на ту же сумму — это та же трата (категории могут отличаться)
    let ov = 0;
    if (isM(c) && r.d >= periodStart(c, now)) {
      const was = Math.max(0, run[c] - L[c]);
      run[c] += r.a;
      ov = Math.max(0, run[c] - L[c]) - was;
    }
    const t = new Date(r.d); t.setHours(20, 0, 0, 0);
    const e = { id: 'ml' + uid(), t, a: r.a, c, n: r.note || r.cat, src: 'ml', key, ov };
    added.push(e);
  });
  if (added.length) {
    const sh = sheet('Log');
    sh.getRange(sh.getLastRow() + 1, 1, added.length, 8).setValues(added.map((e) => [e.id, e.t, e.a, e.c, e.n, e.src, e.key, e.ov || '']));
  }
  const C = calc();
  const todayAdded = added.filter((e) => e.t >= today);
  const warn = Object.keys(CATS).filter((c) => C.catLeft(c) < 0).map((c) => `⚠️ ${CATS[c]}: превышение ${k(-C.catLeft(c))}`);
  const text = `<b>Итог дня, ${dayLabel(now)}</b>\n` +
    `Траты сегодня: ${k(todayAdded.reduce((a, e) => a + e.a, 0))}${todayAdded.length ? ' (' + todayAdded.map((e) => esc(e.n) + ' ' + k(e.a)).join(', ') + ')' : ''}\n` +
    `Неделя: осталось ${k(C.leftW)} из ${k(C.weekLimit)}${C.daysLeft > 1 ? ' — ' + k(Math.max(0, C.leftW) / (C.daysLeft - 1)) + ' в день до воскресенья' : ''}\n` +
    (warn.length ? '\n' + warn.join('\n') : '') +
    (added.length ? `\n\nДобавлено записей: ${added.length}` : '');
  props().setProperty('LAST_IMPORT', String(Date.now()));
  return { found: true, text, added: added.length };
}

/** Итог прошлого месяца по 13 статьям плана экономии. */
function planKey(r) {
  if (r.cashWallet) return null;
  const n = r.note.toLowerCase(), c = r.cat;
  if (n.indexOf('дух') >= 0) return 'perfume';
  if (c === 'Стоянка' || /парков|стоянк/.test(n)) return 'park';
  if (['Apple', 'Телеграмм', 'Steam Игры', 'Meta Quest'].indexOf(c) >= 0 || /claude|sider|\bии\b| ai|vpn|github|иви|подписк|яндекс/.test(n)) return 'subs';
  if (c === 'Наличка') return 'cash';
  if (c === 'Кийим') return 'clothes';
  if (['Uzum', 'Pinduoduo', 'Wb'].indexOf(c) >= 0) return 'market';
  if (c === 'Корзинка') return 'food';
  if (CAFE_CATS.indexOf(c) >= 0 || c === 'Питание') return 'cafe';
  if (['Личные предметы', 'Iphone'].indexOf(c) >= 0) return 'gadgets';
  if (c === 'Транспорт' && !/страховк|замена масла/.test(n)) return 'car';
  if (c === 'Счет за телефон') return 'phone';
  if (c === 'Штраф') return 'fines';
  return null;
}

function monthText(now) {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1), last = new Date(now.getFullYear(), now.getMonth(), 0);
  const file = findExport(new Date(now.getFullYear(), now.getMonth() - 1, 1), last);
  if (!file) return `Экспорт MoneyLover за ${MON_N[first.getMonth()]} на Диске не найден. Выгрузите период за весь прошлый месяц — и напишите /month.`;
  const sum = {};
  PLAN.forEach((p) => { sum[p[0]] = 0; });
  readExport(file).filter((r) => r.d >= first && r.d <= last).forEach((r) => {
    const key = planKey(r);
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

// ===== Анализ по месяцам =====
// Считаем по категориям MoneyLover, примечания — подкатегории.
const MON_S = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const MON_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
const MON_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const ym = (d) => Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
// Короткие названия категорий MoneyLover, чтобы таблица влезала в экран телефона
const SHORT = {
  'Исходящий перевод': 'Переводы', 'Входящий перевод': 'Вход.перев', 'Прочие поступления': 'Прочие пост',
  'Счет за телефон': 'Телефон', 'Счет за электроэнергию': 'Электричес', 'Счет за интернет': 'Интернет',
  'Счет за газ': 'Газ', 'Счет за воду': 'Вода', 'Другие счета': 'Др. счета', 'Личные предметы': 'Личн.вещи',
  'Подарки и пожертвования': 'Подарки', 'Обслуживание дома': 'Обсл.дома', 'Домашние расходы': 'Дом.расход',
  'Прочие расходы': 'Прочие', 'Медицинский осмотр': 'Медосмотр', 'Проценты по долгам': '% по долгам',
  'Предметы быта': 'Быт', 'Образование': 'Образован.', 'Развлечения': 'Развлеч.', 'Возврат долга': 'Возвр.долга',
};
const LW = 10; // ширина подписи в таблице
const NO_NOTE = '—';

const normNote = (n) => { n = String(n || '').trim().replace(/\s+/g, ' '); return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : NO_NOTE; };
/** Суммы за период: {exp: {кат: {sum, notes: {прим: сумма}}}, inc: {...}} в сумах. */
function totalsFromRows(rows, first, last) {
  const t = { exp: {}, inc: {} };
  rows.filter((r) => r.d >= first && r.d <= last && r.s !== 0 && !r.cashWallet).forEach((r) => {
    const kind = r.s < 0 ? 'exp' : 'inc', a = Math.abs(r.s), c = r.cat || 'Без категории';
    const n = c === 'Питание' ? foodGroup(r.note) : normNote(r.note);
    const node = t[kind][c] || (t[kind][c] = { sum: 0, notes: {} });
    node.sum += a;
    node.notes[n] = (node.notes[n] || 0) + a;
  });
  return t;
}
/** Экспорт, где есть весь месяц целиком (сделан не раньше последнего дня месяца). */
let EXPORT_LIST = null;
function allExports() {
  if (EXPORT_LIST) return EXPORT_LIST;
  EXPORT_LIST = [];
  const it = DriveApp.searchFiles("title contains 'MoneyLover' and (title contains 'Пластик' or title contains 'Итого') and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false");
  while (it.hasNext()) EXPORT_LIST.push(it.next());
  return EXPORT_LIST;
}
/**
 * Убирает в корзину лишние экспорты MoneyLover. Оставляет:
 *  - экспорты за длинный период (больше месяца, например годовой) — из них считается история;
 *  - самый свежий файл для каждого периода (например, последний за октябрь).
 * Файлы из корзины Google Диска можно восстановить в течение 30 дней.
 */
function cleanupExports() {
  props().setProperty('LAST_CLEAN', String(Date.now()));
  const newest = {};
  const files = allExports();
  files.forEach((f) => {
    const r = f.getName().match(/(\d{2}\/\d{2}\/\d{4})-(\d{2}\/\d{2}\/\d{4})/);
    if (!r) return;
    const k = r[1] + '-' + r[2];
    // «Итого» (все кошельки) важнее «Пластика» за тот же период, дальше — самый свежий
    const rank = (x) => (/Итого/.test(x.getName()) ? 1e15 : 0) + x.getDateCreated().getTime();
    if (!newest[k] || rank(f) > rank(newest[k])) newest[k] = f;
  });
  let trashed = 0;
  files.forEach((f) => {
    const r = f.getName().match(/(\d{2})\/(\d{2})\/(\d{4})-(\d{2})\/(\d{2})\/(\d{4})/);
    if (!r) return;
    const from = new Date(+r[3], +r[2] - 1, +r[1]), to = new Date(+r[6], +r[5] - 1, +r[4]);
    if ((to - from) / 864e5 > 35) return; // длинный период — оставляем
    if (newest[r[0]] === f) return; // самый свежий за этот период — оставляем
    if (Date.now() - f.getDateCreated().getTime() < 864e5) return; // сегодняшние не трогаем
    try { f.setTrashed(true); trashed++; } catch (e) { console.error(e); }
  });
  EXPORT_LIST = null;
  return trashed;
}

function findExportForMonth(first, last) {
  let best = null;
  allExports().forEach((f) => {
    const r = f.getName().match(/(\d{2})\/(\d{2})\/(\d{4})-(\d{2})\/(\d{2})\/(\d{4})/);
    if (!r) return;
    const from = new Date(+r[3], +r[2] - 1, +r[1]), to = new Date(+r[6], +r[5] - 1, +r[4]);
    if (from > first || to < last || f.getDateCreated() < last) return;
    if (!best || f.getDateCreated() > best.getDateCreated()) best = f;
  });
  return best;
}
/** Итоги закрытого месяца: из листа История, иначе из экспорта (и сохраняет в История). */
function monthTotals(first) {
  const key = ym(first), sh = sheet('История');
  const v = sh.getDataRange().getValues().slice(1).filter((r) => (r[0] instanceof Date ? ym(r[0]) : String(r[0]).replace(/^'/, '')) === key);
  if (v.length) {
    const t = { exp: {}, inc: {} };
    v.forEach((r) => {
      if (!r[2]) return;
      const node = t[r[1]][r[2]] || (t[r[1]][r[2]] = { sum: 0, notes: {} });
      node.sum += +r[4];
      node.notes[String(r[3])] = (node.notes[String(r[3])] || 0) + +r[4];
    });
    return t;
  }
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const file = findExportForMonth(first, last);
  if (!file) return null;
  const t = totalsFromRows(readExportAll(file), first, last);
  const out = [];
  ['exp', 'inc'].forEach((kind) => Object.keys(t[kind]).forEach((c) => Object.keys(t[kind][c].notes).forEach((n) => out.push(["'" + key, kind, c, n, t[kind][c].notes[n]]))));
  if (!out.length) out.push(["'" + key, 'exp', '', '', 0]);
  sh.getRange(sh.getLastRow() + 1, 1, out.length, 5).setValues(out);
  return t;
}
/** Текущий месяц — из самого свежего экспорта, где он есть. */
function currentTotals(now) {
  const file = findExport(new Date(now.getTime() - 40 * 864e5), now);
  return file ? totalsFromRows(readExportAll(file), monthStart(now), now) : null;
}
function curMonth(now) {
  const t = currentTotals(now);
  return t ? { first: monthStart(now), t, partial: true } : null;
}
function last3() {
  const now = new Date(), res = [];
  for (let i = 3; i >= 1; i--) {
    const first = new Date(now.getFullYear(), now.getMonth() - i, 1);
    res.push({ first, t: monthTotals(first) });
  }
  return res;
}
// число для ячейки шириной 5: 13.9 / 101 / +9.5 / -15
const m1 = (v, signed) => { const p = signed && v >= 0 ? '+' : ''; const x = p + (v / 1e6).toFixed(1); return x.length > 4 ? p + Math.round(v / 1e6) : x; };
const sgn = (v) => (Math.abs(v) < 0.05e6 ? '0.0' : m1(v, true));
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
const lpad = (s, n) => (' '.repeat(n) + String(s)).slice(-n);
const pct = (a, b) => (b ? Math.round((a - b) / b * 100) : 0);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pctS = (a, b) => { const p = pct(a, b); return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p) + '%'; };
const mm = (v) => (Math.abs(v) / 1e6).toFixed(1).replace('.', ',');
const signed = (v) => (v >= 0 ? '+' : '−') + mm(v);
const kindTotal = (t, kind) => Object.keys(t[kind]).reduce((a, c) => a + t[kind][c].sum, 0);
const catSum = (t, kind, c) => (t[kind][c] ? t[kind][c].sum : 0);
const noteSum = (t, kind, c, n) => (t[kind][c] && t[kind][c].notes[n]) || 0;

/**
 * Таблица по категориям MoneyLover с примечаниями-подкатегориями.
 * cols — 3 закрытых месяца (+ текущий). Δ — последний столбец (текущий месяц) к предыдущему.
 */
function catTable(kind, closed, cur, extra) {
  const cols = cur ? closed.concat([cur]) : closed;
  const label = (s, sub) => pad(sub ? ' ·' + s : (SHORT[s] || s), LW);
  const head = pad(kind === 'exp' ? 'Категория' : 'Доход', LW) + cols.map((m) => lpad(MON_S[m.first.getMonth()] + (m.partial ? '*' : ''), 5)).join('') + lpad('Δ', 5);
  const line = (lab, vals) => lab + vals.map((v) => lpad(m1(v), 5)).join('') + lpad(sgn(vals[vals.length - 1] - vals[vals.length - 2]), 5);
  const cats = {};
  cols.forEach((m) => Object.keys(m.t[kind]).forEach((c) => { cats[c] = 1; }));
  const total4 = (c) => cols.reduce((a, m) => a + catSum(m.t, kind, c), 0);
  const order = Object.keys(cats).sort((a, b) => total4(b) - total4(a));
  const body = [];
  let small = cols.map(() => 0);
  order.forEach((c) => {
    const vals = cols.map((m) => catSum(m.t, kind, c));
    if (Math.max.apply(null, vals) < 0.15e6) { small = small.map((s, i) => s + vals[i]); return; }
    body.push(line(label(c), vals));
    const notes = {};
    cols.forEach((m) => { if (m.t[kind][c]) Object.keys(m.t[kind][c].notes).forEach((n) => { notes[n] = 1; }); });
    const names = Object.keys(notes);
    if (names.length < 2 && (names[0] === NO_NOTE || !names.length)) return; // нет примечаний — подстроки не нужны
    const nt = (n) => cols.reduce((a, m) => a + noteSum(m.t, kind, c, n), 0);
    const sorted = names.sort((a, b) => nt(b) - nt(a));
    const maxShown = c === 'Питание' ? 6 : 4, minShown = c === 'Питание' ? 0.01e6 : 0.1e6;
    const shown = sorted.filter((n, i) => i < maxShown && Math.max.apply(null, cols.map((m) => noteSum(m.t, kind, c, n))) >= minShown);
    shown.forEach((n) => body.push(line(label(n === NO_NOTE && c === 'Зарплата' ? 'оклад' : n === NO_NOTE ? 'без прим.' : n, true), cols.map((m) => noteSum(m.t, kind, c, n)))));
    const restVals = cols.map((m, i) => vals[i] - shown.reduce((a, n) => a + noteSum(m.t, kind, c, n), 0));
    if (shown.length && Math.max.apply(null, restVals) >= 0.05e6) body.push(line(label('остальное', true), restVals));
  });
  if (Math.max.apply(null, small) > 0) body.push(line(label('Мелкие'), small));
  body.push(line(pad('ИТОГО', LW), cols.map((m) => kindTotal(m.t, kind))));
  const lines = body.concat(extra || []), blocks = [];
  let curB = [head];
  lines.forEach((l) => {
    if ((curB.join('\n').length + l.length) > 3300) { blocks.push(curB); curB = [head]; }
    curB.push(l);
  });
  blocks.push(curB);
  return blocks.map((b) => '<pre>' + esc(b.join('\n')) + '</pre>');
}
// Последний месяц (текущий, если он есть) сравниваем с каждым из прошлых.
function changeLines(months, kind) {
  const last = months[months.length - 1], a = kindTotal(last.t, kind), out = [];
  for (let i = months.length - 2; i >= 0; i--) {
    const b = kindTotal(months[i].t, kind);
    out.push(`• ${cap(MON_N[last.first.getMonth()])}${last.partial ? '*' : ''} к ${MON_DAT[months[i].first.getMonth()]}: <b>${signed(a - b)} млн (${pctS(a, b)})</b>`);
  }
  return out.join('\n');
}
function moversText(months, kind) {
  months = months.slice(-3);
  const b = months[1].t, a = months[2].t, cats = {};
  [a, b].forEach((t) => Object.keys(t[kind]).forEach((c) => { cats[c] = 1; }));
  const diffs = Object.keys(cats).map((c) => [c, catSum(a, kind, c) - catSum(b, kind, c), catSum(a, kind, c), catSum(b, kind, c)]);
  const up = diffs.filter((d) => d[1] > 0.3e6).sort((x, y) => y[1] - x[1]).slice(0, 3);
  const down = diffs.filter((d) => d[1] < -0.3e6).sort((x, y) => x[1] - y[1]).slice(0, 4);
  const mon = MON_PREP[months[2].first.getMonth()];
  let t = '';
  if (up.length) t += `\n\n<b>${kind === 'exp' ? 'Выросло' : 'Больше пришло'} в ${mon}:</b>\n` + up.map((d) => `${kind === 'exp' ? '🔴' : '🟢'} ${d[0]}: +${mm(d[1])} млн (${mm(d[2])} против ${mm(d[3])})`).join('\n');
  if (down.length) t += `\n\n<b>${kind === 'exp' ? 'Уменьшилось' : 'Меньше пришло'}:</b>\n${kind === 'exp' ? '🟢' : '🔴'} ` + down.map((d) => `${d[0]} −${mm(d[1])}`).join(' · ') + ' млн';
  return t;
}
function missingText(months) {
  const miss = months.filter((m) => !m.t);
  return miss.length ? 'Нет полного экспорта MoneyLover за: ' + miss.map((m) => MON_N[m.first.getMonth()]).join(', ') +
    '. Выгрузите на Диск экспорт за весь период (или за каждый из этих месяцев целиком) и нажмите кнопку ещё раз.' : '';
}
function footnote(now, cm, more) {
  return `<i>млн сум; ${cm ? `${MON_S[now.getMonth()]}* — 1–${now.getDate()} число; ` : ''}Δ — ${cm ? MON_N[now.getMonth()] : 'последний месяц'} к ${MON_DAT[(now.getMonth() + (cm ? 11 : 10)) % 12]}; «·» — примечания${more ? '; ' + more : ''}</i>`;
}

function expensesText() {
  const months = last3();
  const miss = missingText(months);
  if (miss) return miss;
  const now = new Date(), cm = curMonth(now), cur = cm && cm.t;
  const tb = catTable('exp', months, cm);
  const parts = tb.map((b, i) => (i ? '' : '<b>📈 Расходы по категориям MoneyLover</b>\n') + b);
  const all = cm ? months.concat([cm]) : months;
  let t = footnote(now, cm) + '\n\n<b>Сравнение:</b>\n' + changeLines(all, 'exp') + moversText(all, 'exp');
  if (cur) {
    const a = months[2].t, days = now.getDate(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const loans = (x) => catSum(x, 'exp', 'Погашение');
    const noLoans = kindTotal(cur, 'exp') - loans(cur), prevNoLoans = kindTotal(a, 'exp') - loans(a);
    t += `\n\n<b>${cap(MON_N[now.getMonth()])} (идёт, 1–${days}):</b> уже ${mm(kindTotal(cur, 'exp'))} млн, из них погашение кредитов ${mm(loans(cur))} млн.` +
      `\nБез кредитов в том же темпе выйдет ~${mm(noLoans / days * dim)} млн за месяц (в ${MON_PREP[months[2].first.getMonth()]} — ${mm(prevNoLoans)} млн).`;
  }
  t += cashWalletText(now);
  return parts.concat([t]);
}
/** Справка: на что ушли наличные (кошелёк «Наличка») в текущем месяце. В итоги не входит — там уже есть снятие. */
function cashWalletText(now) {
  const file = findExport(new Date(now.getTime() - 40 * 864e5), now);
  if (!file) return '';
  const ms = monthStart(now), rows = readExportAll(file).filter((r) => r.d >= ms && r.d <= now);
  const out = rows.filter((r) => r.cashWallet && r.s < 0);
  const took = rows.filter((r) => !r.cashWallet && r.cat === 'Наличка' && r.s < 0).reduce((a, r) => a - r.s, 0);
  if (!out.length && !took) return '';
  const spent = out.reduce((a, r) => a - r.s, 0);
  const by = {};
  out.forEach((r) => { const key = r.cat + (r.note ? ' · ' + r.note : ''); by[key] = (by[key] || 0) - r.s; });
  const list = Object.keys(by).sort((a, b) => by[b] - by[a]).slice(0, 6).map((x) => `• ${esc(x)} — ${k(by[x])}`).join('\n');
  return `\n\n<b>💵 Наличные в ${MON_PREP[now.getMonth()]}:</b> снято ${k(took)}, записано трат из кошелька «Наличка» ${k(spent)}` +
    (took > spent ? ` (не записано ${k(took - spent)})` : '') + (list ? '\n' + list : '');
}

function incomeText() {
  const months = last3();
  const miss = missingText(months);
  if (miss) return miss;
  const now = new Date(), cm = curMonth(now), cur = cm && cm.t;
  const cols = cm ? months.concat([cm]) : months;
  const rest = (t) => kindTotal(t, 'inc') - kindTotal(t, 'exp');
  const extra = [
    pad('Расходы', LW) + cols.map((m) => lpad(m1(kindTotal(m.t, 'exp')), 5)).join(''),
    pad('Остаток', LW) + cols.map((m) => lpad(m1(rest(m.t), true), 5)).join(''),
  ];
  const notes = [];
  const bon = months.map((m) => noteSum(m.t, 'inc', 'Зарплата', 'Бонус'));
  if (bon[2] < bon[1] && bon[1] < bon[0]) notes.push(`🟡 Бонус снижается 3-й месяц подряд: ${bon.map(mm).join(' → ')} млн`);
  else if (bon[2] > bon[1]) notes.push(`🟢 Бонус вырос: ${mm(bon[1])} → ${mm(bon[2])} млн`);
  months.forEach((m) => { if (rest(m.t) < 0) notes.push(`🔴 В ${MON_PREP[m.first.getMonth()]} расходы больше доходов на ${mm(rest(m.t))} млн`); });
  const best = months.slice().sort((x, y) => rest(y.t) - rest(x.t))[0];
  if (rest(best.t) > 0) notes.push(`🟢 Лучший остаток — ${MON_N[best.first.getMonth()]}: +${mm(rest(best.t))} млн`);
  let t = '<b>💰 Доходы по категориям MoneyLover</b>\n' + catTable('inc', months, cm, extra).join('\n') + footnote(now, cm) +
    '\n\n<b>Сравнение:</b>\n' + changeLines(cols, 'inc') + moversText(cols, 'inc') +
    (notes.length ? '\n\n' + notes.join('\n') : '');
  if (cur) t += `\n\n<b>${cap(MON_N[now.getMonth()])} (идёт):</b> пришло ${mm(kindTotal(cur, 'inc'))} млн, из них зарплата ${mm(catSum(cur, 'inc', 'Зарплата'))} млн.`;
  return t;
}

// ===== Расписание =====
function dailyReminder() {
  send('📤 Выгрузите MoneyLover на Диск: кошелёк «Итого» (все кошельки) → Экспорт → «Этот месяц» → Google Диск. В 21:30 я внесу траты и пришлю итог.');
}
function dailyImport() {
  const r = importMoneyLover();
  if (r.found) send(r.text); // без выгрузки — молчим
}
function weeklySummary() { send(weekText(true)); }
function monthlySummary() {
  send(monthText(new Date()));
  try { monthTotals(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)); } catch (e) { console.error(e); }
}
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
  // Работаем без вебхука: удаляем его и сбрасываем застрявшие сообщения
  const r = tg('deleteWebhook', { drop_pending_updates: true });
  console.log('deleteWebhook:', JSON.stringify(r));
  props().deleteProperty('OFFSET');
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyReminder').timeBased().everyDays(1).atHour(21).nearMinute(0).create();
  ScriptApp.newTrigger('dailyImport').timeBased().everyDays(1).atHour(21).nearMinute(30).create();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).nearMinute(45).create();
  ScriptApp.newTrigger('monthlySummary').timeBased().onMonthDay(2).atHour(10).create();
  ScriptApp.newTrigger('wishReminder').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  console.log('Готово. Бот проверяет сообщения раз в минуту — напишите ему /start и подождите до минуты.');
}
