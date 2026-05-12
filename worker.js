/**
 * Clash of Clans Telegram bot for Cloudflare Workers.
 *
 * Modules:
 * - Regular war watcher
 * - CWL watcher
 * - Clan Capital raid watcher
 * - Compact manual stats commands
 * - Fun coin flip
 *
 * Required secrets:
 * - BOT_TOKEN
 * - WEBHOOK_SECRET
 * - SUPERCELL_KEY
 *
 * Required vars:
 * - CLAN_TAG
 * - COC_API_BASE
 * - BOT_USERNAME
 * - WAR_CHAT_ID
 * - TIMEZONE
 *
 * Optional vars:
 * - WAR_THREAD_ID        // Telegram forum topic id for automatic notifications
 * - NOTIFY_CHAT_ID       // optional override for notification chat
 * - NOTIFY_THREAD_ID     // optional override for notification topic
 * - ADMIN_USER_IDS       // comma-separated Telegram user ids for admin commands
 * - RATING_REPORT_INTERVAL_DAYS // auto rating report cadence, default 2
 * - RATING_REPORT_DAYS   // rating period in days, default 14
 * - AUTO_RATING_ENABLED  // true/false, default true
 *
 * Required bindings:
 * - DB D1 database, binding name must be DB
 */

const DEFAULT_COC_API_BASE = "https://cocproxy.royaleapi.dev/v1";
const DEFAULT_TIMEZONE = "Europe/Riga";
const MAX_TG_MESSAGE_LENGTH = 3900;
const RATING_SCHEMA_VERSION = 3;
const RATING_EPOCH_EVENT_ID = `rating_epoch:v${RATING_SCHEMA_VERSION}`;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return jsonResponse({ ok: true, service: "coc-clan-tg-bot" });
    }

    const tgPath = `/webhook/${env.WEBHOOK_SECRET}`;

    if (request.method === "POST" && pathname === tgPath) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

      if (secretHeader && secretHeader !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env));

      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
};

/* -------------------------------------------------------------------------- */
/* Telegram                                                                    */
/* -------------------------------------------------------------------------- */

async function tg(env, method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!data.ok) {
    console.error("Telegram API error:", data);
    throw new Error(data.description || "Telegram API error");
  }

  return data.result;
}

async function tgSendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function tgSendLongMessage(env, chatId, text, extra = {}) {
  const value = String(text || "");

  if (value.length <= MAX_TG_MESSAGE_LENGTH) {
    await tgSendMessage(env, chatId, value, extra);
    return;
  }

  const lines = value.split("\n");
  let chunk = "";

  for (const line of lines) {
    if ((chunk + "\n" + line).length > MAX_TG_MESSAGE_LENGTH) {
      if (chunk.trim()) await tgSendMessage(env, chatId, chunk, extra);
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }

  if (chunk.trim()) await tgSendMessage(env, chatId, chunk, extra);
}

function withExtra(base = {}, extra = {}) {
  return {
    ...(base || {}),
    ...(extra || {}),
  };
}

function getMessageThreadId(message) {
  const value = Number(message && message.message_thread_id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function replyExtraFromMessage(message) {
  const threadId = getMessageThreadId(message);
  return threadId ? { message_thread_id: threadId } : {};
}

function getNotificationChatId(env) {
  return String(env.NOTIFY_CHAT_ID || env.WAR_CHAT_ID || "").trim();
}

function getNotificationThreadId(env) {
  const value = Number(env.NOTIFY_THREAD_ID || env.WAR_THREAD_ID || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function notificationExtra(env, extra = {}, target = {}) {
  const threadId = Number(target && target.threadId ? target.threadId : getNotificationThreadId(env));
  if (!threadId) return extra || {};
  return withExtra(extra, { message_thread_id: threadId });
}

async function tgSendNotification(env, text, extra = {}, fallbackTarget = {}) {
  const target = await resolveNotificationTarget(env, fallbackTarget);
  const chatId = target.chatId;

  if (!chatId) {
    console.log("Notification skipped: WAR_CHAT_ID/NOTIFY_CHAT_ID is empty");
    return null;
  }

  return tgSendLongMessage(env, chatId, text, notificationExtra(env, extra, target));
}

async function resolveNotificationTarget(env, fallbackTarget = {}) {
  const envChatId = getNotificationChatId(env);
  if (envChatId) {
    return {
      chatId: envChatId,
      threadId: getNotificationThreadId(env),
      source: "env",
    };
  }

  const stored = await getStoredNotificationTarget(env);
  if (stored && stored.chatId) return { ...stored, source: "db" };

  const fallbackChatId = String((fallbackTarget && fallbackTarget.chatId) || "").trim();
  if (fallbackChatId) {
    const threadId = Number((fallbackTarget && fallbackTarget.threadId) || 0);
    return {
      chatId: fallbackChatId,
      threadId: Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null,
      source: "fallback",
    };
  }

  return { chatId: "", threadId: null, source: "missing" };
}

async function getStoredNotificationTarget(env) {
  if (!env.DB) return null;

  try {
    await ensureRuntimeTables(env.DB);
    const value = await getBotSetting(env.DB, "notification_target");
    const target = safeJsonParse(value || "{}");
    const chatId = String((target && target.chatId) || "").trim();
    const threadId = Number((target && target.threadId) || 0);
    if (!chatId) return null;
    return {
      chatId,
      threadId: Number.isSafeInteger(threadId) && threadId > 0 ? threadId : null,
      updatedAt: target.updatedAt || "",
    };
  } catch (e) {
    console.error("getStoredNotificationTarget error:", e);
    return null;
  }
}

async function handleTelegramUpdate(update, env) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const chatType = msg.chat.type || "private";
  const text = String(msg.text || "").trim();
  const replyExtra = replyExtraFromMessage(msg);
  const userId = msg.from && msg.from.id ? String(msg.from.id) : "";

  if (!text) return;

  const isGroupChat = chatType === "group" || chatType === "supergroup";
  const command = parseTelegramCommand(text, env);

  if (!command) {
    if (isCoinText(text)) {
      await sendCoinFlip(env, chatId, replyExtra);
      return;
    }

    const handledPendingInput = await maybeHandlePendingInput(env, chatId, text, replyExtra);
    if (handledPendingInput) return;
  }

  if (isGroupChat && !command) return;
  if (isGroupChat && command && command.mentionedBot && !command.isForThisBot) return;

  if (!command) {
    await tgSendMessage(env, chatId, "Не понял команду. Напиши /help.", replyExtra);
    return;
  }

  if (command.name === "start" || command.name === "help" || command.name === "menu") {
    await sendHelp(env, chatId, replyExtra, userId);
    return;
  }

  if (command.name === "stats") {
    await handleStatsCommand(env, chatId, command.args, replyExtra);
    return;
  }

  if (command.name === "link" || command.name === "unlink" || command.name === "me" || command.name === "я") {
    if (command.name === "link") {
      await linkPlayerToTelegram(env, chatId, userId, msg.from, command.args, replyExtra);
      return;
    }

    if (command.name === "unlink") {
      await unlinkPlayerFromTelegram(env, chatId, userId, command.args, replyExtra);
      return;
    }

    await sendMyStatus(env, chatId, userId, replyExtra);
    return;
  }

  if (["rating", "weak", "missed", "kicklist", "rating_status", "ratingstatus", "player", "игрок", "setnotify", "notify_here", "notify_status", "notify_test"].includes(command.name)) {
    if (!isAdminUser(env, userId)) {
      if (!isGroupChat) await tgSendMessage(env, chatId, "Эта команда доступна только админу.", replyExtra);
      return;
    }

    if (command.name === "setnotify" || command.name === "notify_here") {
      await setNotificationTargetCommand(env, chatId, replyExtra);
      return;
    }

    if (command.name === "notify_status") {
      await sendNotifyStatus(env, chatId, replyExtra);
      return;
    }

    if (command.name === "notify_test") {
      await sendNotifyTest(env, chatId, replyExtra);
      return;
    }

    if (command.name === "rating_status" || command.name === "ratingstatus") {
      await sendRatingStatus(env, chatId, replyExtra);
      return;
    }

    if (command.name === "player" || command.name === "игрок") {
      await sendPlayerRatingCard(env, chatId, command.args, replyExtra);
      return;
    }

    const options = parseRatingCommandArgs(command.args, env);
    const mode = command.name === "kicklist" ? "weak" : command.name;
    await sendRatingReport(env, chatId, options.days, mode, replyExtra, options);
    return;
  }

  if (command.name === "war" || command.name === "status") {
    await sendWarStatus(env, chatId, replyExtra);
    return;
  }

  if (command.name === "todo") {
    await sendTodo(env, chatId, command.args, replyExtra);
    return;
  }

  if (command.name === "eff" || command.name === "result") {
    await handleWarEfficiencyCommand(env, chatId, command.args, replyExtra);
    return;
  }

  if (command.name === "cwl" || command.name === "lvk" || command.name === "лвк") {
    await sendCwlStatus(env, chatId, replyExtra);
    return;
  }

  if (command.name === "raid" || command.name === "raids" || command.name === "рейд" || command.name === "рейды") {
    await sendRaidStats(env, chatId, parseRequestedCount(command.args, 5, 20), replyExtra);
    return;
  }

  if (command.name === "coin" || command.name === "flip" || command.name === "monetka") {
    await sendCoinFlip(env, chatId, replyExtra);
    return;
  }

  if (command.name === "ping") {
    await tgSendMessage(env, chatId, "pong", replyExtra);
    return;
  }

  if (command.name === "chatid" || command.name === "threadid") {
    const threadId = getMessageThreadId(msg);
    const lines = [
      "ID этого чата:",
      `<code>${escapeHtml(String(chatId))}</code>`,
      "",
      "ID этой ветки:",
      `<code>${escapeHtml(threadId ? String(threadId) : "нет ветки")}</code>`,
      "",
      "Для автоуведомлений поставь:",
      `<code>WAR_CHAT_ID = \"${escapeHtml(String(chatId))}\"</code>`,
      "",
      "Или проще: админ может написать <code>/setnotify</code>, и бот сохранит этот чат/ветку в БД.",
    ];

    if (threadId) {
      lines.push(`<code>WAR_THREAD_ID = \"${escapeHtml(String(threadId))}\"</code>`);
    }

    await tgSendMessage(env, chatId, lines.join("\n"), withExtra(replyExtra, { parse_mode: "HTML" }));
    return;
  }

  if (command.name === "check") {
    await sendManualCheck(env, chatId, replyExtra);
    return;
  }

  if (command.name === "attacks") {
    await sendWarAttacks(env, chatId, replyExtra);
    return;
  }

  if (isGroupChat) return;

  await tgSendMessage(env, chatId, "Не понял команду. Напиши /help.", replyExtra);
}

function parseTelegramCommand(text, env) {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^\/([a-zA-Z0-9_а-яА-ЯёЁ]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/);

  if (!match) return null;

  const name = match[1].toLowerCase();
  const mentionedBot = match[2] ? match[2].toLowerCase() : "";
  const botUsername = String(env.BOT_USERNAME || "").replace(/^@/, "").toLowerCase();
  const args = normalized.slice(match[0].length).trim();

  return {
    name,
    args,
    mentionedBot,
    isForThisBot: !mentionedBot || !botUsername || mentionedBot === botUsername,
  };
}

async function sendHelp(env, chatId, replyExtra = {}, userId = "") {
  const lines = [
    "⚔️ <b>Клешка ботик</b>",
    "",
    "<b>Главное</b>",
    "⚔️ /war — текущая КВ",
    "🕒 /todo all — хвосты КВ/ЛВК/рейдов",
    "🏰 /cwl — ЛВК сейчас",
    "🛖 /raid — рейды столицы",
    "🙋 /me — мои хвосты и рейтинг",
    "🔗 /link #TAG — привязать игровой тег",
    "",
    "<b>Статистика</b>",
    "📊 /stats — меню статистики",
    "🏆 /stats war 10 — результативность КВ",
    "🏰 /stats cwl — сводка ЛВК",
    "🛖 /stats raid 5 — последние рейды",
    "",
    "<b>Прочее</b>",
    "🪙 /coin — монетка 50/50",
  ];

  if (isAdminUser(env, userId)) {
    lines.push(
      "",
      "<b>Админ</b>",
      "🧮 /rating 14 — рейтинг за 14 дней",
      "📌 /rating short — короткая сводка",
      "🔴 /weak 14 — кандидаты на проверку/кик",
      "⚠️ /missed 14 — пропуски атак и рейдов",
      "👤 /player имя — карточка игрока",
      "🧰 /rating_status — диагностика рейтинга",
      "📣 /setnotify — закрепить этот чат/ветку для автоуведомлений",
      "📣 /notify_status — проверить цель уведомлений",
      "📣 /notify_test — тест автоуведомления"
    );
  }

  lines.push("", "Авто: КВ, ЛВК, новые атаки, рейды, рейтинг и напоминания без дублей.");

  await tgSendMessage(env, chatId, lines.join("\n"), withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function handleStatsCommand(env, chatId, args, replyExtra = {}) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const section = (parts[0] || "").toLowerCase();
  const count = parseRequestedCount(parts[1], 10, 50);

  if (!section) {
    await sendStatsHelp(env, chatId, replyExtra);
    return;
  }

  if (["war", "wars", "kv", "кв"].includes(section)) {
    await sendWarEfficiency(env, chatId, count, replyExtra);
    return;
  }

  if (["cwl", "lvk", "лвк", "league"].includes(section)) {
    await sendCwlStatus(env, chatId, replyExtra);
    return;
  }

  if (["raid", "raids", "рейд", "рейды", "capital"].includes(section)) {
    await sendRaidStats(env, chatId, parseRequestedCount(parts[1], 5, 20), replyExtra);
    return;
  }

  await sendStatsHelp(env, chatId, replyExtra);
}

async function sendStatsHelp(env, chatId, replyExtra = {}) {
  await tgSendMessage(
    env,
    chatId,
    [
      "📊 <b>Статистика</b>",
      "",
      "Выбери раздел командой:",
      "🏆 <code>/stats war 10</code> — последние 10 КВ",
      "🏰 <code>/stats cwl</code> — текущая ЛВК",
      "🛖 <code>/stats raid 5</code> — последние 5 рейдов",
      "",
      "Короткие команды тоже работают:",
      "<code>/eff 10</code>, <code>/cwl</code>, <code>/raid</code>",
    ].join("\n"),
    withExtra(replyExtra, { parse_mode: "HTML" })
  );
}

async function handleWarEfficiencyCommand(env, chatId, args, replyExtra = {}) {
  const count = parseRequestedCount(args, 0, 50);

  if (count) {
    await sendWarEfficiency(env, chatId, count, replyExtra);
    return;
  }

  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не могу ждать ввод числа: не подключена D1-база.", replyExtra);
    return;
  }

  await ensureRuntimeTables(env.DB);
  await setChatState(env.DB, chatId, "awaiting_eff_count", {}, 120);

  await tgSendMessage(
    env,
    chatId,
    [
      "🏆 За сколько последних КВ посчитать результативность?",
      "Напиши число, например: <code>10</code>",
      "Или сразу: <code>/eff 10</code>",
    ].join("\n"),
    withExtra(replyExtra, { parse_mode: "HTML" })
  );
}

async function sendManualCheck(env, chatId, replyExtra = {}) {
  try {
    const target = await resolveNotificationTarget(env, { chatId, threadId: replyExtra.message_thread_id });
    const results = await runAllWatchers(env, { notify: true, chatId, threadId: replyExtra.message_thread_id, manual: true });

    await tgSendMessage(
      env,
      chatId,
      [
        "✅ Проверка выполнена.",
        "",
        `Уведомления: ${target.chatId ? escapeHtml(formatNotificationSource(target.source)) : "не задано"}`,
        `КВ: ${escapeHtml(formatWatcherResult(results.war))}`,
        `ЛВК: ${escapeHtml(formatWatcherResult(results.cwl))}`,
        `Рейды: ${escapeHtml(formatWatcherResult(results.raid))}`,
      ].join("\n"),
      withExtra(replyExtra, { parse_mode: "HTML" })
    );
  } catch (e) {
    console.error("manual check error:", e);
    await tgSendMessage(env, chatId, `Не смог выполнить проверку: ${e.message || e}`, replyExtra);
  }
}

function formatWatcherResult(result) {
  if (!result) return "-";
  if (result.ok === false) return `ошибка: ${result.error || "-"}`;

  const parts = [result.state || "-"];
  if (Number.isFinite(Number(result.insertedAttacks))) parts.push(`новых атак: ${numberOrZero(result.insertedAttacks)}`);
  if (Number.isFinite(Number(result.notifiedAttacks))) parts.push(`уведомлено атак: ${numberOrZero(result.notifiedAttacks)}`);
  if (result.stateNotified) parts.push("смена статуса отправлена");
  if (result.timerNotified || result.reminder) parts.push("напоминание отправлено");
  if (result.war) parts.push(`раунд: ${formatWatcherResult(result.war)}`);
  return parts.join(", ");
}

async function setNotificationTargetCommand(env, chatId, replyExtra = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, не могу сохранить цель уведомлений.", replyExtra);
    return;
  }

  const target = {
    chatId: String(chatId),
    threadId: Number(replyExtra.message_thread_id || 0) || null,
    updatedAt: new Date().toISOString(),
  };

  await setBotSetting(env.DB, "notification_target", JSON.stringify(target));

  await tgSendMessage(
    env,
    chatId,
    [
      "✅ Автоуведомления закреплены здесь.",
      "",
      `Чат: <code>${escapeHtml(target.chatId)}</code>`,
      `Ветка: <code>${escapeHtml(target.threadId ? String(target.threadId) : "нет")}</code>`,
      "",
      "Теперь cron будет слать сюда старты, атаки, хвосты и завершения.",
    ].join("\n"),
    withExtra(replyExtra, { parse_mode: "HTML" })
  );
}

async function sendNotifyStatus(env, chatId, replyExtra = {}) {
  const envChatId = getNotificationChatId(env);
  const envThreadId = getNotificationThreadId(env);
  const stored = await getStoredNotificationTarget(env);
  const active = await resolveNotificationTarget(env, { chatId, threadId: replyExtra.message_thread_id });

  const lines = [
    "📣 <b>Диагностика уведомлений</b>",
    "",
    `Активная цель: <b>${escapeHtml(formatNotificationSource(active.source))}</b>`,
    `Чат: <code>${escapeHtml(active.chatId || "не задан")}</code>`,
    `Ветка: <code>${escapeHtml(active.threadId ? String(active.threadId) : "нет")}</code>`,
    "",
    "Источник из переменных:",
    `WAR/NOTIFY_CHAT_ID: <code>${escapeHtml(envChatId || "не задан")}</code>`,
    `WAR/NOTIFY_THREAD_ID: <code>${escapeHtml(envThreadId ? String(envThreadId) : "нет")}</code>`,
    "",
    "Источник из БД:",
    `chatId: <code>${escapeHtml(stored && stored.chatId ? stored.chatId : "не задан")}</code>`,
    `threadId: <code>${escapeHtml(stored && stored.threadId ? String(stored.threadId) : "нет")}</code>`,
  ];

  if (stored && stored.updatedAt) lines.push(`Обновлено: <code>${escapeHtml(stored.updatedAt)}</code>`);
  if (!envChatId && !(stored && stored.chatId)) lines.push("", "Чтобы cron начал писать сюда: <code>/setnotify</code>");

  await tgSendMessage(env, chatId, lines.join("\n"), withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function sendNotifyTest(env, chatId, replyExtra = {}) {
  const fallback = { chatId, threadId: replyExtra.message_thread_id };
  const target = await resolveNotificationTarget(env, fallback);

  if (!target.chatId) {
    await tgSendMessage(env, chatId, "Цель автоуведомлений не задана. Напиши /setnotify в нужной группе или ветке.", replyExtra);
    return;
  }

  await tgSendNotification(
    env,
    [
      "📣 <b>Тест автоуведомлений</b>",
      "",
      "Если это сообщение видно в нужном месте, доставка работает.",
      `Источник: <b>${escapeHtml(formatNotificationSource(target.source))}</b>`,
    ].join("\n"),
    { parse_mode: "HTML" },
    fallback
  );
}

function formatNotificationSource(source) {
  if (source === "env") return "переменные Worker";
  if (source === "db") return "настройка в БД";
  if (source === "fallback") return "текущий чат команды";
  return "не задана";
}

async function linkPlayerToTelegram(env, chatId, userId, from, args, replyExtra = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, привязка недоступна.", replyExtra);
    return;
  }

  const tag = normalizeTag(String(args || "").trim());
  if (!tag) {
    await tgSendMessage(env, chatId, "Напиши тег игрока: <code>/link #ABC123</code>", withExtra(replyExtra, { parse_mode: "HTML" }));
    return;
  }

  await ensureRuntimeTables(env.DB);

  const roster = await getClanRosterForRating(env);
  const member = roster.find((item) => normalizeTag(item.tag) === tag);
  if (!member) {
    await tgSendMessage(env, chatId, "Не нашёл такой тег в текущем составе клана.", replyExtra);
    return;
  }

  await env.DB.prepare(`
    INSERT OR REPLACE INTO player_links (
      tg_user_id, tg_username, player_tag, player_name, town_hall_level, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    String(userId || ""),
    from && from.username ? from.username : "",
    member.tag || tag,
    member.name || member.tag || tag,
    numberOrZero(member.townHallLevel),
    new Date().toISOString()
  ).run();

  await tgSendMessage(env, chatId, `Готово: <b>${escapeHtml(member.name || tag)}</b> привязан к тебе.`, withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function unlinkPlayerFromTelegram(env, chatId, userId, args, replyExtra = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, привязка недоступна.", replyExtra);
    return;
  }

  await ensureRuntimeTables(env.DB);
  const tag = normalizeTag(String(args || "").trim());

  if (tag) {
    await env.DB.prepare("DELETE FROM player_links WHERE tg_user_id = ? AND player_tag = ?").bind(String(userId || ""), tag).run();
  } else {
    await env.DB.prepare("DELETE FROM player_links WHERE tg_user_id = ?").bind(String(userId || "")).run();
  }

  await tgSendMessage(env, chatId, "Привязка удалена.", replyExtra);
}

async function getPlayerLinksByTags(db, tags = []) {
  await ensureRuntimeTables(db);
  const normalized = [...new Set((tags || []).map((tag) => normalizeTag(tag)).filter(Boolean))];
  if (!normalized.length) return new Map();

  const placeholders = normalized.map(() => "?").join(",");
  const response = await db.prepare(`
    SELECT * FROM player_links
    WHERE player_tag IN (${placeholders})
  `).bind(...normalized).all();
  const map = new Map();

  for (const row of response.results || []) {
    const tag = normalizeTag(row.player_tag);
    if (!tag || map.has(tag)) continue;
    map.set(tag, row);
  }

  return map;
}

async function getPlayerLinksByUser(db, userId) {
  await ensureRuntimeTables(db);
  const response = await db.prepare(`
    SELECT * FROM player_links
    WHERE tg_user_id = ?
    ORDER BY created_at DESC
  `).bind(String(userId || "")).all();
  return response.results || [];
}

async function sendMyStatus(env, chatId, userId, replyExtra = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, /me недоступна.", replyExtra);
    return;
  }

  await ensureRuntimeTables(env.DB);
  const links = await getPlayerLinksByUser(env.DB, userId);
  if (!links.length) {
    await tgSendMessage(env, chatId, "Сначала привяжи игровой тег: <code>/link #ABC123</code>", withExtra(replyExtra, { parse_mode: "HTML" }));
    return;
  }

  const lines = ["🙋 <b>Мои хвосты</b>", ""];

  for (const link of links) {
    const tag = normalizeTag(link.player_tag);
    lines.push(`👤 <b>${escapeHtml(link.player_name || tag)}</b>`);
    lines.push(await renderMyWarLine(env, tag, "war"));
    lines.push(await renderMyWarLine(env, tag, "cwl"));
    lines.push(await renderMyRaidLine(env, tag));
    lines.push(await renderMyRatingLine(env, tag));
    lines.push("");
  }

  await tgSendLongMessage(env, chatId, lines.join("\n").trim(), withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function renderMyWarLine(env, playerTag, type = "war") {
  try {
    const war = type === "cwl" ? await getCurrentCwlWarForTodo(env) : await getCurrentWar(env);
    const label = type === "cwl" ? "ЛВК" : "КВ";
    if (!war || war.state === "notInWar") return `${label}: нет активной войны`;

    const member = ((war.clan && war.clan.members) || []).find((item) => normalizeTag(item.tag) === playerTag);
    if (!member) return `${label}: ты не в составе`;

    const possible = numberOrZero(war.attacksPerMember) || (type === "cwl" ? 1 : 2);
    const used = (member.attacks || []).length;
    const left = Math.max(possible - used, 0);
    return `${label}: <b>${used}/${possible}</b>${left ? `, осталось <b>${left}</b>` : " ✅"}`;
  } catch (e) {
    if (type === "cwl" && isCocNotFoundError(e)) return "ЛВК: нет активной ЛВК";
    return `${type === "cwl" ? "ЛВК" : "КВ"}: не смог получить данные`;
  }
}

async function getCurrentCwlWarForTodo(env) {
  const group = await getCurrentCwlGroup(env);
  if (!group || group.state === "notInWar") return null;
  return getRelevantCwlWar(env, group);
}

async function renderMyRaidLine(env, playerTag) {
  try {
    const seasons = await getCapitalRaidSeasons(env, 1);
    const season = seasons[0];
    if (!season) return "Рейды: нет данных";

    const member = getRaidMembers(season).find((item) => normalizeTag(item.tag) === playerTag);
    const possible = member ? getRaidAttackLimit(member) || 6 : 6;
    const used = member ? numberOrZero(member.attacks) : 0;
    const left = Math.max(possible - used, 0);
    return `Рейды: <b>${used}/${possible}</b>${left ? `, осталось <b>${left}</b>` : " ✅"}`;
  } catch {
    return "Рейды: не смог получить данные";
  }
}

async function renderMyRatingLine(env, playerTag) {
  try {
    const snapshot = await refreshRatingSnapshot(env);
    const days = getNumberEnv(env, "RATING_REPORT_DAYS", 14);
    const report = await buildRatingData(env.DB, days, snapshot.rosterMembers, snapshot.ratingSince);
    const player = report.players.find((item) => normalizeTag(item.tag) === playerTag);
    if (!player) return "Рейтинг: нет данных";
    return `Рейтинг: <b>${formatRatingScore(player)}</b>, ${escapeHtml(formatPlayerStatus(player.status))}`;
  } catch {
    return "Рейтинг: не смог получить данные";
  }
}

/* -------------------------------------------------------------------------- */
/* Clash of Clans API                                                          */
/* -------------------------------------------------------------------------- */

function getCocApiBase(env) {
  return String(env.COC_API_BASE || DEFAULT_COC_API_BASE).replace(/\/+$/, "");
}

function normalizeTag(tag) {
  const text = String(tag || "").trim().toUpperCase();
  return text.startsWith("#") ? text : `#${text}`;
}

function encodeTag(tag) {
  const normalized = normalizeTag(tag);
  if (!normalized || normalized === "#") throw new Error("tag is empty");
  return encodeURIComponent(normalized);
}

async function cocGet(env, path) {
  const url = `${getCocApiBase(env)}${path}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.SUPERCELL_KEY}`,
      Accept: "application/json",
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("CoC API error response:", {
      status: res.status,
      path,
      apiBase: getCocApiBase(env),
      clanTag: env.CLAN_TAG,
      hasKey: Boolean(env.SUPERCELL_KEY),
      keyLength: env.SUPERCELL_KEY ? env.SUPERCELL_KEY.length : 0,
      data,
    });

    const reason = data && (data.reason || data.message)
      ? `${data.reason || ""} ${data.message || ""}`.trim()
      : JSON.stringify(data);

    throw new Error(`CoC API ${res.status}${reason ? `: ${reason}` : ""}`);
  }

  return data;
}

async function getCurrentWar(env) {
  return cocGet(env, `/clans/${encodeTag(env.CLAN_TAG)}/currentwar`);
}

async function getClanInfo(env) {
  return cocGet(env, `/clans/${encodeTag(env.CLAN_TAG)}`);
}

function getClanRosterMembers(clan) {
  if (Array.isArray(clan && clan.memberList)) return clan.memberList;
  if (Array.isArray(clan && clan.members)) return clan.members;
  return [];
}

async function getWarLog(env, limit = 10) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 10), 50));
  const data = await cocGet(env, `/clans/${encodeTag(env.CLAN_TAG)}/warlog?limit=${safeLimit}`);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

async function getCurrentCwlGroup(env) {
  return cocGet(env, `/clans/${encodeTag(env.CLAN_TAG)}/currentwar/leaguegroup`);
}

async function getCwlWar(env, warTag) {
  return cocGet(env, `/clanwarleagues/wars/${encodeTag(warTag)}`);
}

async function getCapitalRaidSeasons(env, limit = 5) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 5), 20));
  const data = await cocGet(env, `/clans/${encodeTag(env.CLAN_TAG)}/capitalraidseasons?limit=${safeLimit}`);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

/* -------------------------------------------------------------------------- */
/* Manual commands: regular war                                                */
/* -------------------------------------------------------------------------- */

async function sendWarStatus(env, chatId, replyExtra = {}) {
  try {
    const war = await getCurrentWar(env);
    await tgSendLongMessage(env, chatId, renderWarStatus(war, env), withExtra(replyExtra, { parse_mode: "HTML" }));
  } catch (e) {
    console.error("sendWarStatus error:", e);
    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог получить текущую КВ.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
        "",
        "Чаще всего это закрытый журнал войн или проблема с API-ключом.",
      ].join("\n"),
      withExtra(replyExtra, { parse_mode: "HTML" })
    );
  }
}

async function sendWarTodo(env, chatId, replyExtra = {}) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в КВ.", replyExtra);
      return;
    }

    await tgSendLongMessage(env, chatId, renderTodoBlock(war, 80), withExtra(replyExtra, { parse_mode: "HTML" }));
  } catch (e) {
    console.error("sendWarTodo error:", e);
    await tgSendMessage(env, chatId, `Не смог получить список атак: ${e.message || e}`, replyExtra);
  }
}

async function sendTodo(env, chatId, args = "", replyExtra = {}) {
  const section = String(args || "all").trim().toLowerCase() || "all";
  const wanted = section === "all" || section === "все" || section === "всё"
    ? ["war", "cwl", "raid"]
    : section.includes("cwl") || section.includes("lvk") || section.includes("лвк")
      ? ["cwl"]
      : section.includes("raid") || section.includes("рейд")
        ? ["raid"]
        : ["war"];

  const lines = ["🕒 <b>Хвосты активностей</b>", ""];

  for (const item of wanted) {
    if (item === "war") lines.push(await renderWarTodoSection(env, "war"));
    if (item === "cwl") lines.push(await renderCwlTodoSection(env));
    if (item === "raid") lines.push(await renderRaidTodoSection(env));
    lines.push("");
  }

  await tgSendLongMessage(env, chatId, lines.join("\n").trim(), withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function renderWarTodoSection(env, type = "war") {
  try {
    const war = await getCurrentWar(env);
    if (!war || war.state === "notInWar") return "⚔️ <b>КВ</b>\nКлан сейчас не в КВ.";
    return ["⚔️ <b>КВ</b>", renderActivityTimeLine(war, env), "", renderTodoBlock(war, 80)].filter(Boolean).join("\n");
  } catch (e) {
    return `⚔️ <b>КВ</b>\nНе смог получить данные: ${escapeHtml(e.message || String(e))}`;
  }
}

async function renderCwlTodoSection(env) {
  try {
    const group = await getCurrentCwlGroup(env);
    if (!group || group.state === "notInWar") return "🏰 <b>ЛВК</b>\nАктивной ЛВК не найдено.";
    const war = await getRelevantCwlWar(env, group);
    if (!war) return "🏰 <b>ЛВК</b>\nТекущий раунд пока не найден.";
    return ["🏰 <b>ЛВК</b>", renderActivityTimeLine(war, env), "", renderTodoBlock(war, 80)].filter(Boolean).join("\n");
  } catch (e) {
    if (isCocNotFoundError(e)) return "🏰 <b>ЛВК</b>\nАктивной ЛВК не найдено.";
    return `🏰 <b>ЛВК</b>\nНе смог получить данные: ${escapeHtml(e.message || String(e))}`;
  }
}

async function renderRaidTodoSection(env) {
  try {
    const seasons = await getCapitalRaidSeasons(env, 1);
    const season = seasons[0];
    if (!season) return "🛖 <b>Рейды</b>\nРейды столицы не найдены.";
    const roster = await getClanRosterForRating(env);
    return ["🛖 <b>Рейды</b>", renderRaidTimeLine(season, env), "", renderRaidTodoBlock(season, roster, 80)].filter(Boolean).join("\n");
  } catch (e) {
    return `🛖 <b>Рейды</b>\nНе смог получить данные: ${escapeHtml(e.message || String(e))}`;
  }
}

async function sendWarAttacks(env, chatId, replyExtra = {}) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в КВ.", replyExtra);
      return;
    }

    const attacks = collectWarAttacks(war);

    if (!attacks.length) {
      await tgSendMessage(env, chatId, "В этой КВ пока нет атак.", replyExtra);
      return;
    }

    const lines = ["⚔️ <b>Атаки текущей КВ</b>", ""];
    for (const attack of attacks.slice(-60)) lines.push(renderAttackLine(attack));
    if (attacks.length > 60) lines.push("", `Показаны последние 60 атак из ${attacks.length}.`);

    await tgSendLongMessage(env, chatId, lines.join("\n"), withExtra(replyExtra, { parse_mode: "HTML" }));
  } catch (e) {
    console.error("sendWarAttacks error:", e);
    await tgSendMessage(env, chatId, `Не смог получить атаки: ${e.message || e}`, replyExtra);
  }
}

async function sendWarEfficiency(env, chatId, requestedCount, replyExtra = {}) {
  try {
    const count = Math.max(1, Math.min(Number(requestedCount || 10), 50));
    const wars = await getWarLog(env, count);

    if (!wars.length) {
      await tgSendMessage(env, chatId, "Не нашёл историю КВ. Возможно, журнал войн закрыт или войн ещё нет.", replyExtra);
      return;
    }

    await tgSendLongMessage(env, chatId, renderWarEfficiency(wars, count, env), withExtra(replyExtra, { parse_mode: "HTML" }));
  } catch (e) {
    console.error("sendWarEfficiency error:", e);
    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог посчитать результативность КВ.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
        "",
        "Если ошибка 403 — проверь, что журнал войн открыт.",
      ].join("\n"),
      withExtra(replyExtra, { parse_mode: "HTML" })
    );
  }
}

/* -------------------------------------------------------------------------- */
/* CWL                                                                         */
/* -------------------------------------------------------------------------- */

async function sendCwlStatus(env, chatId, replyExtra = {}) {
  try {
    const group = await getCurrentCwlGroup(env);

    if (!group || group.state === "notInWar") {
      await tgSendMessage(env, chatId, "🏰 Сейчас активной ЛВК не найдено.", replyExtra);
      return;
    }

    const cwlWar = await getRelevantCwlWar(env, group).catch((e) => {
      console.error("getRelevantCwlWar error:", e);
      return null;
    });

    await tgSendLongMessage(env, chatId, renderCwlStatus(group, cwlWar, env), withExtra(replyExtra, { parse_mode: "HTML" }));
  } catch (e) {
    console.error("sendCwlStatus error:", e);

    if (isCocNotFoundError(e)) {
      await tgSendMessage(
        env,
        chatId,
        [
          "🏰 <b>ЛВК сейчас не идёт</b>",
          "",
          "Когда начнётся Лига войны кланов, команда <code>/cwl</code> покажет группу, раунды и текущую войну.",
        ].join("\n"),
        withExtra(replyExtra, { parse_mode: "HTML" })
      );
      return;
    }

    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог получить ЛВК.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
      ].join("\n"),
      withExtra(replyExtra, { parse_mode: "HTML" })
    );
  }
}

async function getRelevantCwlWar(env, group) {
  const clanTag = normalizeTag(env.CLAN_TAG);
  const warTags = [];

  for (const round of group.rounds || []) {
    for (const warTag of round.warTags || []) {
      if (warTag && warTag !== "#0") warTags.push(warTag);
    }
  }

  const uniqueWarTags = [...new Set(warTags)].slice(-14);
  const wars = [];

  for (const warTag of uniqueWarTags) {
    try {
      const war = await getCwlWar(env, warTag);
      const hasOurClan = normalizeTag(war.clan && war.clan.tag) === clanTag || normalizeTag(war.opponent && war.opponent.tag) === clanTag;
      if (hasOurClan) wars.push({ ...war, warTag });
    } catch (e) {
      console.error("CWL war fetch failed", { warTag, message: e.message || String(e) });
    }
  }

  if (!wars.length) return null;

  const active = wars.find((war) => war.state === "inWar") || wars.find((war) => war.state === "preparation");
  if (active) return normalizeWarSides(active, clanTag);

  wars.sort((a, b) => {
    const aTime = parseCocTime(a.endTime || a.startTime || "")?.getTime() || 0;
    const bTime = parseCocTime(b.endTime || b.startTime || "")?.getTime() || 0;
    return bTime - aTime;
  });

  return normalizeWarSides(wars[0], clanTag);
}

function normalizeWarSides(war, ourClanTag) {
  if (!war || !war.clan || !war.opponent) return war;
  if (normalizeTag(war.clan.tag) === normalizeTag(ourClanTag)) return war;
  if (normalizeTag(war.opponent.tag) !== normalizeTag(ourClanTag)) return war;
  return { ...war, clan: war.opponent, opponent: war.clan };
}

function renderCwlStatus(group, war, env) {
  const lines = [
    "🏰 <b>Лига войны кланов</b>",
    "",
    `Сезон: <b>${escapeHtml(group.season || "-")}</b>`,
    `Статус группы: <b>${escapeHtml(formatCwlState(group.state))}</b>`,
    `Кланов в группе: <b>${(group.clans || []).length}</b>`,
  ];

  if (war) {
    lines.push(
      "",
      "<b>Текущий/последний раунд нашего клана</b>",
      renderWarTitleLine(war),
      `Статус: <b>${escapeHtml(formatWarState(war.state))}</b>`,
      renderScoreLine(war),
      renderDestructionLine(war),
      renderAttacksLeftLine(war)
    );

    if (war.startTime) lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
    if (war.endTime) lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);

    lines.push("", renderTodoBlock(war, 30));
  } else {
    lines.push("", "Наш раунд пока не найден в warTags группы.");
  }

  return lines.join("\n");
}

function formatCwlState(state) {
  const map = {
    notInWar: "ЛВК не идёт",
    preparation: "подготовка",
    inWar: "идёт раунд",
    warEnded: "раунд закончился",
    ended: "ЛВК закончилась",
  };
  return map[state] || state || "неизвестно";
}

/* -------------------------------------------------------------------------- */
/* Capital raids                                                               */
/* -------------------------------------------------------------------------- */

async function sendRaidStats(env, chatId, requestedCount = 5, replyExtra = {}) {
  try {
    const count = Math.max(1, Math.min(Number(requestedCount || 5), 20));
    const seasons = await getCapitalRaidSeasons(env, count);

    if (!seasons.length) {
      await tgSendMessage(env, chatId, "🛖 Рейды столицы не найдены.", replyExtra);
      return;
    }

    await tgSendLongMessage(env, chatId, renderRaidStats(seasons, env), withExtra(replyExtra, { parse_mode: "HTML" }));
  } catch (e) {
    console.error("sendRaidStats error:", e);
    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог получить рейды столицы.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
      ].join("\n"),
      withExtra(replyExtra, { parse_mode: "HTML" })
    );
  }
}

function renderRaidStats(seasons, env) {
  const latest = seasons[0];
  const lines = [
    "🛖 <b>Рейды столицы</b>",
    "",
    renderRaidSeasonSummary(latest, env, true),
  ];

  const members = getRaidMembers(latest);
  if (members.length) {
    lines.push("", "👥 <b>Участники текущего/последнего рейда</b>");

    const sorted = [...members].sort((a, b) => {
      if (numberOrZero(b.capitalResourcesLooted) !== numberOrZero(a.capitalResourcesLooted)) {
        return numberOrZero(b.capitalResourcesLooted) - numberOrZero(a.capitalResourcesLooted);
      }
      return numberOrZero(b.attacks) - numberOrZero(a.attacks);
    });

    for (const member of sorted.slice(0, 20)) {
      const attacks = numberOrZero(member.attacks);
      const limit = getRaidAttackLimit(member);
      const loot = numberOrZero(member.capitalResourcesLooted);
      lines.push(`• ${escapeHtml(member.name || member.tag)} — <b>${attacks}/${limit || "?"}</b>, золото <b>${loot}</b>`);
    }
  }

  if (seasons.length > 1) {
    lines.push("", "📚 <b>Последние рейды</b>");
    for (const season of seasons.slice(0, 8)) lines.push(renderRaidShortLine(season, env));
  }

  return lines.join("\n");
}

function renderRaidSeasonSummary(season, env, detailed = false) {
  const lines = [
    `Статус: <b>${escapeHtml(formatRaidState(season.state))}</b>`,
    `Золото столицы: <b>${numberOrZero(season.capitalTotalLoot)}</b>`,
    `Атак: <b>${numberOrZero(season.totalAttacks)}</b>`,
    `Рейдов завершено: <b>${numberOrZero(season.raidsCompleted)}</b>`,
    `Районов уничтожено: <b>${numberOrZero(season.enemyDistrictsDestroyed)}</b>`,
  ];

  if (season.offensiveReward !== undefined) lines.push(`Медали атаки: <b>${numberOrZero(season.offensiveReward)}</b>`);
  if (season.defensiveReward !== undefined) lines.push(`Медали защиты: <b>${numberOrZero(season.defensiveReward)}</b>`);
  if (season.startTime) lines.push(`Старт: <b>${escapeHtml(formatCocTime(season.startTime, env))}</b>`);
  if (season.endTime) lines.push(`Конец: <b>${escapeHtml(formatCocTime(season.endTime, env))}</b>`);

  if (detailed) {
    const left = getRaidAttacksLeft(season);
    if (left.totalPossible > 0) lines.push(`Использование атак: <b>${left.used}/${left.totalPossible}</b>, осталось <b>${left.left}</b>`);
  }

  return lines.join("\n");
}

function renderRaidShortLine(season, env) {
  const date = season.endTime ? formatCocTime(season.endTime, env) : season.startTime ? formatCocTime(season.startTime, env) : "-";
  return `• ${escapeHtml(date)} — ${escapeHtml(formatRaidState(season.state))}, золото <b>${numberOrZero(season.capitalTotalLoot)}</b>, атак <b>${numberOrZero(season.totalAttacks)}</b>`;
}

function formatRaidState(state) {
  const map = {
    ongoing: "идёт",
    ended: "закончился",
  };
  return map[state] || state || "неизвестно";
}

function getRaidMembers(season) {
  return Array.isArray(season && season.members) ? season.members : [];
}

function getRaidAttackLimit(member) {
  const base = numberOrZero(member.attackLimit);
  const bonus = numberOrZero(member.bonusAttackLimit);
  return base + bonus;
}

function getRaidAttacksLeft(season) {
  const members = getRaidMembers(season);
  let used = 0;
  let totalPossible = 0;

  for (const member of members) {
    used += numberOrZero(member.attacks);
    totalPossible += getRaidAttackLimit(member);
  }

  return { used, totalPossible, left: Math.max(totalPossible - used, 0) };
}


/* -------------------------------------------------------------------------- */
/* Admin rating                                                                */
/* -------------------------------------------------------------------------- */

function isAdminUser(env, userId) {
  const ids = String(env.ADMIN_USER_IDS || "1252859891")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return ids.includes(String(userId || ""));
}

function parseRatingCommandArgs(args, env = {}) {
  const defaultDays = getNumberEnv(env, "RATING_REPORT_DAYS", 14);
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  let days = defaultDays;
  let view = "full";

  for (const part of parts) {
    const value = part.toLowerCase();
    if (/^\d{1,2}$/.test(value)) {
      days = parseRequestedCount(value, defaultDays, 90);
      continue;
    }
    if (["short", "compact", "кратко"].includes(value)) view = "short";
    if (["full", "all", "полный", "все", "всё"].includes(value)) view = "full";
  }

  return { days, view };
}

async function sendRatingReport(env, chatId, days = 14, mode = "rating", replyExtra = {}, options = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, рейтинг недоступен.", replyExtra);
    return;
  }

  await ensureRuntimeTables(env.DB);
  const snapshot = await refreshRatingSnapshot(env);

  const report = await buildRatingData(env.DB, days, snapshot && snapshot.rosterMembers, snapshot && snapshot.ratingSince);
  const text = renderRatingReport(report, mode, env, options);

  await tgSendLongMessage(env, chatId, text, withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function sendRatingStatus(env, chatId, replyExtra = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, диагностика рейтинга недоступна.", replyExtra);
    return;
  }

  await ensureRuntimeTables(env.DB);
  const snapshot = await refreshRatingSnapshot(env);
  const audit = await buildRatingStorageAudit(env.DB, snapshot.ratingSince, env);
  const runtime = await buildRuntimeEventStatus(env.DB, env);

  const lines = [
    "🧰 <b>Статус рейтинга</b>",
    "",
    `Версия схемы: <b>${RATING_SCHEMA_VERSION}</b>`,
    `Новая эпоха с: <b>${escapeHtml(formatIsoDateTime(snapshot.ratingSince, env))}</b>`,
    `Текущий состав клана: <b>${snapshot.rosterMembers.length}</b>`,
    "",
    `Всего записей player_events: <b>${audit.totalRows}</b>`,
    `Учитывается новой версией: <b>${audit.usableRows}</b>`,
    `Игнорируется старой версии: <b>${audit.oldVersionRows}</b>`,
    `Игнорируется до новой эпохи: <b>${audit.beforeEpochRows}</b>`,
    `Игнорируется незавершённых КВ/ЛВК: <b>${audit.unfinishedWarRows}</b>`,
    "",
    `Последняя новая запись: <b>${escapeHtml(audit.lastUsableEvent || "нет")}</b>`,
    "",
    "Последние события бота:",
    `КВ: <b>${escapeHtml(runtime.war || "нет данных")}</b>`,
    `ЛВК: <b>${escapeHtml(runtime.cwl || "нет данных")}</b>`,
    `Рейды: <b>${escapeHtml(runtime.raid || "нет данных")}</b>`,
    "",
    "Способ расчёта:",
    "КВ/ЛВК пишутся только после завершения войны.",
    "Рейды пишутся только после завершения рейд-уикенда.",
    "Старые записи до этой версии не участвуют.",
  ];

  await tgSendMessage(env, chatId, lines.join("\n"), withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function sendPlayerRatingCard(env, chatId, query, replyExtra = {}) {
  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не подключена D1-база, карточка игрока недоступна.", replyExtra);
    return;
  }

  const needle = normalizeSearchText(query);
  if (!needle) {
    await tgSendMessage(env, chatId, "Напиши имя или тег: <code>/player BLVCK</code>", withExtra(replyExtra, { parse_mode: "HTML" }));
    return;
  }

  await ensureRuntimeTables(env.DB);
  const snapshot = await refreshRatingSnapshot(env);
  const days = getNumberEnv(env, "RATING_REPORT_DAYS", 14);
  const report = await buildRatingData(env.DB, days, snapshot.rosterMembers, snapshot.ratingSince);
  const matches = report.players.filter((player) => {
    const haystack = `${player.name || ""} ${player.tag || ""}`;
    return normalizeSearchText(haystack).includes(needle);
  });

  if (!matches.length) {
    await tgSendMessage(env, chatId, "Игрок не найден в текущем составе или новых данных рейтинга.", replyExtra);
    return;
  }

  if (matches.length > 1) {
    const lines = [
      "Нашёл несколько игроков, уточни запрос:",
      "",
      ...matches.slice(0, 12).map((player) => `• ${escapeHtml(player.name)} — <code>${escapeHtml(player.tag)}</code>`),
    ];
    await tgSendMessage(env, chatId, lines.join("\n"), withExtra(replyExtra, { parse_mode: "HTML" }));
    return;
  }

  await tgSendMessage(env, chatId, renderPlayerRatingCard(matches[0], report, env), withExtra(replyExtra, { parse_mode: "HTML" }));
}

async function buildRatingStorageAudit(db, ratingSince = "", env = {}) {
  const response = await db.prepare(`
    SELECT source, event_time, metrics_json
    FROM player_events
    ORDER BY event_time DESC
  `).all();
  const rows = response.results || [];
  const sinceTime = ratingSince ? new Date(ratingSince).getTime() : 0;
  const audit = {
    totalRows: rows.length,
    usableRows: 0,
    oldVersionRows: 0,
    beforeEpochRows: 0,
    unfinishedWarRows: 0,
    lastUsableEvent: "",
  };

  for (const row of rows) {
    const metrics = safeJsonParse(row.metrics_json) || {};
    const eventTime = new Date(row.event_time || "").getTime();

    if (numberOrZero(metrics.ratingSchemaVersion) !== RATING_SCHEMA_VERSION) {
      audit.oldVersionRows++;
      continue;
    }
    if (sinceTime && eventTime < sinceTime) {
      audit.beforeEpochRows++;
      continue;
    }
    if (shouldSkipRatingEvent(row, metrics)) {
      audit.unfinishedWarRows++;
      continue;
    }

    audit.usableRows++;
    if (!audit.lastUsableEvent) {
      audit.lastUsableEvent = `${sourceLabel(row.source || metrics.kind)} ${formatIsoDateTime(row.event_time, env)}`;
    }
  }

  return audit;
}

async function buildRuntimeEventStatus(db, env = {}) {
  const warRow = await db.prepare(`
    SELECT state, raw_json, updated_at
    FROM wars
    ORDER BY updated_at DESC
    LIMIT 1
  `).first().catch(() => null);
  const response = await db.prepare(`
    SELECT type, state, raw_json, updated_at
    FROM bot_events
    WHERE type IN ('cwl', 'raid')
    ORDER BY updated_at DESC
  `).all();
  const rows = response.results || [];
  const result = {};

  if (warRow) result.war = formatWarRuntimeLabel(safeJsonParse(warRow.raw_json) || {}, warRow, env);

  for (const row of rows) {
    if (result[row.type]) continue;
    const raw = safeJsonParse(row.raw_json) || {};
    const label = row.type === "war"
      ? formatWarRuntimeLabel(raw, row, env)
      : row.type === "cwl"
        ? formatCwlRuntimeLabel(raw, row, env)
        : formatRaidRuntimeLabel(raw, row, env);
    result[row.type] = label;
  }

  return result;
}

function formatWarRuntimeLabel(war, row, env = {}) {
  const opponent = war.opponent && war.opponent.name ? ` vs ${war.opponent.name}` : "";
  const end = war.endTime ? `, конец ${formatCocTime(war.endTime, env)}` : "";
  return `${formatWarState(row.state || war.state)}${opponent}${end}`;
}

function formatCwlRuntimeLabel(group, row, env = {}) {
  const season = group.season ? ` ${group.season}` : "";
  return `${formatCwlState(row.state || group.state)}${season}`;
}

function formatRaidRuntimeLabel(season, row, env = {}) {
  const end = season.endTime ? `, конец ${formatCocTime(season.endTime, env)}` : "";
  return `${formatRaidState(row.state || season.state)}${end}`;
}

async function maybeSendScheduledRatingReport(env) {
  if (!env.DB) return { ok: false, error: "DB missing" };

  const target = await resolveNotificationTarget(env);
  if (!target.chatId) return { ok: false, error: "notification chat missing" };

  await ensureRuntimeTables(env.DB);

  const intervalDays = getNumberEnv(env, "RATING_REPORT_INTERVAL_DAYS", 2);
  const days = getNumberEnv(env, "RATING_REPORT_DAYS", 14);
  const bucket = Math.floor(Date.now() / (intervalDays * 24 * 60 * 60 * 1000));
  const kind = `rating_report_${intervalDays}d_${bucket}`;

  if (await isReminderSent(env.DB, "rating_report", kind)) {
    return { ok: true, skipped: true, reason: "already_sent" };
  }

  const snapshot = await refreshRatingSnapshot(env);

  const report = await buildRatingData(env.DB, days, snapshot && snapshot.rosterMembers, snapshot && snapshot.ratingSince);
  if (!report.players.length || report.eventCount === 0) {
    return { ok: true, skipped: true, reason: "no_rating_data" };
  }

  await tgSendNotification(env, renderRatingReport(report, "rating", env, { view: "short" }), { parse_mode: "HTML" });
  await markReminderSent(env.DB, "rating_report", kind);

  return { ok: true, sent: true, players: report.players.length, days };
}

async function refreshRatingSnapshot(env) {
  if (!env.DB) return { rosterMembers: [] };
  await ensureRuntimeTables(env.DB);

  const rosterMembers = await getClanRosterForRating(env);
  const ratingSince = await getRatingEpoch(env.DB);

  try {
    const war = await getCurrentWar(env);
    if (war && war.state !== "notInWar") {
      await recordWarRatingEvents(env.DB, war, "war", { ratingSince });
    }
  } catch (e) {
    console.error("rating refresh current war failed", e.message || String(e));
  }

  try {
    const group = await getCurrentCwlGroup(env);
    if (group && group.state !== "notInWar") {
      const cwlWar = await getRelevantCwlWar(env, group);
      if (cwlWar) await recordWarRatingEvents(env.DB, cwlWar, "cwl", { ratingSince });
    }
  } catch (e) {
    if (!isCocNotFoundError(e)) console.error("rating refresh cwl failed", e.message || String(e));
  }

  try {
    const seasons = await getCapitalRaidSeasons(env, 5);
    for (const season of seasons) await recordRaidRatingEvents(env.DB, season, env, rosterMembers, { ratingSince });
  } catch (e) {
    console.error("rating refresh raids failed", e.message || String(e));
  }

  return { rosterMembers, ratingSince };
}

async function getClanRosterForRating(env) {
  try {
    const clan = await getClanInfo(env);
    return getClanRosterMembers(clan);
  } catch (e) {
    console.error("rating roster fetch failed", e.message || String(e));
    return [];
  }
}

async function getRatingEpoch(db) {
  await ensureRuntimeTables(db);

  const existing = await getEventRecord(db, RATING_EPOCH_EVENT_ID);
  const payload = existing && existing.raw_json ? safeJsonParse(existing.raw_json) : null;
  if (payload && payload.startedAt) return payload.startedAt;

  const startedAt = new Date().toISOString();
  await upsertEventRecord(db, RATING_EPOCH_EVENT_ID, "rating_epoch", "active", {
    version: RATING_SCHEMA_VERSION,
    startedAt,
  });
  return startedAt;
}

function isEventAfterRatingEpoch(eventDate, ratingSince) {
  if (!ratingSince) return true;
  if (!eventDate || !Number.isFinite(eventDate.getTime())) return false;
  return eventDate.getTime() >= new Date(ratingSince).getTime();
}

async function recordWarRatingEvents(db, war, source = "war", options = {}) {
  await ensureRuntimeTables(db);

  if (!isWarFinishedForRating(war)) return 0;

  const members = (war.clan && war.clan.members) || [];
  if (!members.length) return 0;

  const eventId = getWarId(war, source);
  const eventDate = parseCocTime(war.endTime || war.startTime) || new Date();
  if (!isEventAfterRatingEpoch(eventDate, options.ratingSince)) return 0;

  const possibleAttacks = getWarRatingPossibleAttacks(war, source);
  let count = 0;

  for (const member of members) {
    const metrics = buildWarMemberMetrics(member, possibleAttacks, source, war.state || "");
    const eventKey = `${eventId}:${member.tag || member.name}`;

    await upsertPlayerEvent(db, {
      eventKey,
      source,
      eventId,
      playerTag: member.tag || member.name || "unknown",
      playerName: member.name || member.tag || "unknown",
      eventTime: eventDate.toISOString(),
      score: metrics.score,
      metrics,
    });

    count++;
  }

  return count;
}

function isWarFinishedForRating(war) {
  return war && war.state === "warEnded";
}

function getWarRatingPossibleAttacks(war, source = "war") {
  const apiValue = numberOrZero(war.attacksPerMember);
  if (apiValue > 0) return apiValue;
  return source === "cwl" ? 1 : 2;
}

function buildWarMemberMetrics(member, possibleAttacks, source, state) {
  const attacks = Array.isArray(member.attacks) ? member.attacks : [];
  const used = attacks.length;
  const possible = Math.max(1, numberOrZero(possibleAttacks));
  const missed = Math.max(possible - used, 0);

  let stars = 0;
  let destruction = 0;
  let triples = 0;
  let weakAttacks = 0;
  let zeroStars = 0;
  let oneStars = 0;

  for (const attack of attacks) {
    const attackStars = numberOrZero(attack.stars);
    const attackDestruction = numberOrZero(attack.destructionPercentage);

    stars += attackStars;
    destruction += attackDestruction;
    if (attackStars >= 3) triples++;
    if (attackStars <= 1) weakAttacks++;
    if (attackStars === 0) zeroStars++;
    if (attackStars === 1) oneStars++;
  }

  const avgStars = used ? stars / used : 0;
  const avgDestruction = used ? destruction / used : 0;
  const usageRate = Math.min(1, used / possible);
  const badWarQuality = used > 0 && (
    (used >= 2 && triples === 0) ||
    (used === 1 && triples === 0) ||
    avgStars < 2
  );
  const perfectWar = possible >= 2 && used >= 2 && triples >= 2;
  const goodWar = used > 0 && missed === 0 && triples >= 1;
  const noMissBonus = missed === 0 && used > 0 ? 8 : 0;
  const perfectBonus = perfectWar ? 8 : 0;

  let qualityPenalty = 0;
  if (badWarQuality) {
    if (used >= 2 && triples === 0) qualityPenalty = Math.max(qualityPenalty, 12);
    if (used === 1 && triples === 0) qualityPenalty = Math.max(qualityPenalty, 8);
    if (avgStars < 2) qualityPenalty = Math.max(qualityPenalty, 10);
  }

  const qualityScore = used
    ? clamp((avgStars / 3) * 36 + (Math.min(avgDestruction, 100) / 100) * 14 + Math.min(triples, used) / used * 12, 0, 62)
    : 0;

  let score = usageRate * 38 + qualityScore + noMissBonus + perfectBonus;
  score -= missed * 20;
  score -= qualityPenalty;
  score -= zeroStars * 6;
  score -= oneStars * 3;

  const reasons = [];
  if (missed > 0) reasons.push(`-${missed * 20} за пропущенные атаки КВ/ЛВК`);
  if (used >= 2 && triples === 0) reasons.push("-12 за войну без 3⭐ атак");
  else if (used === 1 && triples === 0) reasons.push("-8 за единственную атаку без 3⭐");
  if (used > 0 && avgStars < 2) reasons.push("-10 за средние звёзды ниже 2.0");
  if (weakAttacks >= 2) reasons.push(`-${weakAttacks * 3} за слабые атаки 0-1⭐`);
  if (avgDestruction && avgDestruction < 60) reasons.push(`низкий процент: ${avgDestruction.toFixed(0)}%`);
  if (perfectWar) reasons.push("+8 за идеальную войну 3⭐+3⭐");
  else if (triples > 0) reasons.push(`3⭐ атак: ${triples}`);
  if (noMissBonus) reasons.push("+8 за отсутствие пропусков КВ/ЛВК");

  return {
    ratingSchemaVersion: RATING_SCHEMA_VERSION,
    ratingRecordedAt: new Date().toISOString(),
    kind: source,
    state,
    possible,
    used,
    missed,
    stars,
    avgStars,
    destruction,
    avgDestruction,
    triples,
    weakAttacks,
    zeroStars,
    oneStars,
    badWarQuality,
    badWarQualityCount: badWarQuality ? 1 : 0,
    perfectWar,
    perfectWarCount: perfectWar ? 1 : 0,
    goodWar,
    goodWarCount: goodWar ? 1 : 0,
    missedWarAttacks: missed,
    warAttacksUsed: used,
    warAttacksAvailable: possible,
    threeStarAttacks: triples,
    score: clamp(Math.round(score), 0, 100),
    reasons,
  };
}

async function recordRaidRatingEvents(db, season, env, rosterMembers = [], options = {}) {
  await ensureRuntimeTables(db);

  if (!isRaidFinishedForRating(season)) return 0;

  const members = getRaidMembers(season);
  const allMembers = mergeRaidMembersWithRoster(members, rosterMembers, season);
  if (!allMembers.length) return 0;

  const eventId = getRaidEventId(season);
  const eventDate = parseCocTime(season.endTime || season.startTime) || new Date();
  if (!isEventAfterRatingEpoch(eventDate, options.ratingSince)) return 0;

  const goodLoot = getNumberEnv(env || {}, "RATING_RAID_GOOD_LOOT", 22000);
  let count = 0;

  for (const member of allMembers) {
    const possible = getRaidAttackLimit(member) || 6;
    const used = numberOrZero(member.attacks);
    const missed = Math.max(possible - used, 0);
    const loot = numberOrZero(member.capitalResourcesLooted);
    const usageScore = Math.min(1, used / Math.max(possible, 1)) * 60;
    const lootScore = Math.min(1, loot / goodLoot) * 30;
    const fullBonus = missed === 0 && used > 0 ? 10 : 0;
    const score = clamp(Math.round(usageScore + lootScore + fullBonus - missed * 10), 0, 100);
    const reasons = [];

    if (missed > 0) reasons.push(`-${missed * 10} за пропущенные атаки рейдов`);
    if (loot < goodLoot * 0.55 && used > 0) reasons.push(`мало золота: ${loot}`);
    if (missed === 0 && used > 0) reasons.push("+6 за закрытые рейды");

    const metrics = {
      ratingSchemaVersion: RATING_SCHEMA_VERSION,
      ratingRecordedAt: new Date().toISOString(),
      kind: "raid",
      state: season.state || "",
      possible,
      used,
      missed,
      loot,
      score,
      reasons,
    };

    await upsertPlayerEvent(db, {
      eventKey: `${eventId}:${member.tag || member.name}`,
      source: "raid",
      eventId,
      playerTag: member.tag || member.name || "unknown",
      playerName: member.name || member.tag || "unknown",
      eventTime: eventDate.toISOString(),
      score,
      metrics,
    });

    count++;
  }

  return count;
}

function mergeRaidMembersWithRoster(raidMembers, rosterMembers, season) {
  const byTag = new Map();

  for (const member of raidMembers || []) {
    const tag = normalizeTag(member.tag || member.name || "");
    if (!tag) continue;
    byTag.set(tag, member);
  }

  if (!isRaidFinishedForRating(season)) return [...byTag.values()];

  for (const member of rosterMembers || []) {
    const tag = normalizeTag(member.tag || member.name || "");
    if (!tag || byTag.has(tag)) continue;
    byTag.set(tag, {
      tag: member.tag || member.name,
      name: member.name || member.tag || "unknown",
      attacks: 0,
      attackLimit: 6,
      capitalResourcesLooted: 0,
      absentFromRaid: true,
    });
  }

  return [...byTag.values()];
}

function isRaidFinishedForRating(season) {
  const state = String((season && season.state) || "").toLowerCase();
  if (!state) return true;
  return state === "ended";
}

async function upsertPlayerEvent(db, event) {
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO player_events (
      event_key, source, event_id, player_tag, player_name,
      event_time, score, metrics_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_key) DO UPDATE SET
      source = excluded.source,
      event_id = excluded.event_id,
      player_tag = excluded.player_tag,
      player_name = excluded.player_name,
      event_time = excluded.event_time,
      score = excluded.score,
      metrics_json = excluded.metrics_json,
      updated_at = excluded.updated_at
  `).bind(
    event.eventKey,
    event.source,
    event.eventId,
    event.playerTag,
    event.playerName,
    event.eventTime,
    Number(event.score || 0),
    JSON.stringify(event.metrics || {}),
    now,
    now
  ).run();
}

async function buildRatingData(db, days = 14, rosterMembers = [], ratingSince = "") {
  await ensureRuntimeTables(db);

  const safeDays = Math.max(1, Math.min(Number(days || 14), 90));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const response = await db.prepare(`
    SELECT * FROM player_events
    WHERE event_time >= ?
    ORDER BY event_time DESC
  `).bind(cutoff).all();

  const rows = response.results || [];
  const byPlayer = new Map();
  let eventCount = 0;
  const rosterTags = new Set((rosterMembers || []).map((member) => normalizeTag(member.tag || member.name || "")).filter(Boolean));

  for (const member of rosterMembers || []) {
    const tag = member.tag || member.name || "";
    if (!tag || byPlayer.has(tag)) continue;
    byPlayer.set(tag, createEmptyRatingPlayer(tag, member.name || tag));
  }

  for (const row of rows) {
    const metrics = safeJsonParse(row.metrics_json) || {};
    if (shouldSkipRatingEvent(row, metrics)) continue;
    if (ratingSince && new Date(row.event_time || "").getTime() < new Date(ratingSince).getTime()) continue;

    const tag = row.player_tag || row.player_name || "unknown";
    if (rosterTags.size && !rosterTags.has(normalizeTag(tag))) continue;
    eventCount++;

    if (!byPlayer.has(tag)) {
      byPlayer.set(tag, createEmptyRatingPlayer(tag, row.player_name || tag));
    }

    addRatingEvent(byPlayer.get(tag), row, metrics);
  }

  const players = [...byPlayer.values()]
    .map(finalizeRatingPlayer)
    .sort((a, b) => {
      if (a.bucketRank !== b.bucketRank) return b.bucketRank - a.bucketRank;
      if (a.score !== b.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

  return {
    days: safeDays,
    cutoff,
    ratingSince,
    eventCount,
    players,
  };
}

function shouldSkipRatingEvent(row, metrics) {
  if (numberOrZero(metrics.ratingSchemaVersion) !== RATING_SCHEMA_VERSION) return true;

  const source = row.source || metrics.kind || "";
  if (source !== "war" && source !== "cwl") return false;
  return metrics.state !== "warEnded";
}

function createEmptyRatingPlayer(tag, name) {
  return {
    tag,
    name,
    weightedScore: 0,
    weight: 0,
    events: 0,
    warEvents: 0,
    cwlEvents: 0,
    raidEvents: 0,
    warMissed: 0,
    cwlMissed: 0,
    raidMissed: 0,
    attacksUsed: 0,
    attacksPossible: 0,
    warAttacksUsed: 0,
    warAttacksAvailable: 0,
    raidAttacksUsed: 0,
    raidAttacksPossible: 0,
    stars: 0,
    attackSamples: 0,
    destruction: 0,
    triples: 0,
    threeStarAttacks: 0,
    badWarQualityCount: 0,
    perfectWarCount: 0,
    goodWarCount: 0,
    weakAttacks: 0,
    zeroStars: 0,
    oneStars: 0,
    loot: 0,
    raidFull: 0,
    reasons: new Map(),
    dateStats: new Map(),
    warHistory: [],
    recentEvents: [],
  };
}

function addRatingEvent(player, row, metrics) {
  const source = row.source || metrics.kind || "unknown";
  const weight = source === "cwl" ? 1.45 : source === "raid" ? 0.7 : 1;
  const score = clamp(Number(row.score || metrics.score || 0), 0, 100);

  player.name = row.player_name || player.name;
  player.events++;
  player.weightedScore += score * weight;
  player.weight += weight;

  for (const reason of metrics.reasons || []) addReason(player, reason);

  player.recentEvents.push({
    source,
    time: row.event_time || "",
    score,
    metrics,
  });

  const dateKey = getRatingDateKey(row.event_time);
  const eventBad = isBadRatingEvent(source, score, metrics);
  if (dateKey) {
    const dateStat = player.dateStats.get(dateKey) || { date: dateKey, bad: false };
    dateStat.bad = dateStat.bad || eventBad;
    player.dateStats.set(dateKey, dateStat);
  }

  if (source === "raid") {
    player.raidEvents++;
    player.raidMissed += numberOrZero(metrics.missed);
    player.raidAttacksUsed += numberOrZero(metrics.used);
    player.raidAttacksPossible += numberOrZero(metrics.possible);
    player.loot += numberOrZero(metrics.loot);
    if (numberOrZero(metrics.missed) === 0 && numberOrZero(metrics.used) > 0) player.raidFull++;
    return;
  }

  if (source === "cwl") player.cwlEvents++;
  else player.warEvents++;

  const missed = numberOrZero(metrics.missed);
  const used = numberOrZero(metrics.used);
  const possible = numberOrZero(metrics.possible);
  const triples = numberOrZero(metrics.triples);
  const badWarQuality = Boolean(metrics.badWarQuality) || (used > 0 && triples === 0);
  const perfectWar = Boolean(metrics.perfectWar) || (possible >= 2 && used >= 2 && triples >= 2);
  const goodWar = Boolean(metrics.goodWar) || (used > 0 && missed === 0 && triples > 0);

  if (source === "cwl") player.cwlMissed += missed;
  else player.warMissed += missed;

  player.attacksUsed += used;
  player.attacksPossible += possible;
  player.warAttacksUsed += used;
  player.warAttacksAvailable += possible;
  player.stars += numberOrZero(metrics.stars);
  player.destruction += numberOrZero(metrics.destruction);
  player.attackSamples += used;
  player.triples += triples;
  player.threeStarAttacks += triples;
  player.weakAttacks += numberOrZero(metrics.weakAttacks);
  player.zeroStars += numberOrZero(metrics.zeroStars);
  player.oneStars += numberOrZero(metrics.oneStars);
  if (badWarQuality) player.badWarQualityCount++;
  if (perfectWar) player.perfectWarCount++;
  if (goodWar) player.goodWarCount++;

  player.warHistory.push({
    time: row.event_time || "",
    badWarQuality,
    perfectWar,
    goodWar,
    missed,
    score,
  });
}

function addReason(player, reason) {
  if (!reason) return;
  player.reasons.set(reason, (player.reasons.get(reason) || 0) + 1);
}

function finalizeRatingPlayer(player) {
  const baseScore = player.weight ? Math.round(player.weightedScore / player.weight) : 0;
  const avgStars = player.attackSamples ? player.stars / player.attackSamples : 0;
  const avgDestruction = player.attackSamples ? player.destruction / player.attackSamples : 0;
  const missedCritical = player.warMissed + player.cwlMissed;
  const totalMissed = missedCritical + player.raidMissed;
  const usageRate = player.attacksPossible ? player.attacksUsed / player.attacksPossible * 100 : null;
  const raidUsageRate = player.raidAttacksPossible ? player.raidAttacksUsed / player.raidAttacksPossible * 100 : null;
  const threeStarRate = player.attackSamples ? player.threeStarAttacks / player.attackSamples * 100 : 0;
  const warReliabilityRate = player.attacksPossible ? player.attacksUsed / player.attacksPossible * 100 : null;
  const confidence = player.events < 3 ? "low" : player.events < 6 ? "medium" : "high";
  const badState = calculateBadState(player.dateStats);
  const perfectWarStreak = calculatePerfectWarStreak(player.warHistory);
  const lowConfidence = confidence === "low";
  const hasRisk = missedCritical > 0 || player.badWarQualityCount > 0 || badState.badDays > 0 || player.raidMissed >= 3 || (player.events > 0 && baseScore < 60);
  const seriousRisk = missedCritical >= 4 || badState.badStreak >= 3 || hasSeveralBadWarEventsInRow(player.warHistory, 2);

  let topScoreBonus = 0;
  if (player.perfectWarCount > 0) topScoreBonus += Math.min(player.perfectWarCount * 8, 24);
  if (perfectWarStreak >= 3) topScoreBonus += 10;
  else if (perfectWarStreak >= 2) topScoreBonus += 5;
  if (player.attackSamples >= 4 && threeStarRate >= 70) topScoreBonus += 10;
  if (player.attacksPossible > 0 && missedCritical === 0) topScoreBonus += 8;
  if (player.raidEvents > 0 && player.raidMissed === 0 && player.raidAttacksUsed > 0) topScoreBonus += 6;
  else if (player.raidFull > 0) topScoreBonus += 3;

  let regularityPenalty = 0;
  if (player.badWarQualityCount >= 3) regularityPenalty += 20;
  else if (player.badWarQualityCount >= 2) regularityPenalty += 10;
  if (badState.badDays >= 3) regularityPenalty += 8;
  if (badState.badStreak >= 3) regularityPenalty += 10;
  if (player.attackSamples >= 2 && avgStars < 2) regularityPenalty += 10;

  const score = clamp(Math.round(baseScore + topScoreBonus - regularityPenalty), 0, 100);

  let status = "green";
  let bucketRank = 4;

  if (player.events === 0) {
    status = "no_data";
    bucketRank = -1;
  } else if (lowConfidence && seriousRisk) {
    status = "red";
    bucketRank = 2;
  } else if (lowConfidence && hasRisk) {
    status = "low_risk";
    bucketRank = 1;
  } else if (lowConfidence) {
    status = "low_data";
    bucketRank = 0;
  } else if (
    score >= 90 &&
    missedCritical === 0 &&
    player.badWarQualityCount === 0 &&
    (player.perfectWarCount > 0 || (player.attackSamples >= 4 && threeStarRate >= 70))
  ) {
    status = "top";
    bucketRank = 5;
  } else if (
    score < 50 ||
    missedCritical >= 2 ||
    player.badWarQualityCount >= 2 ||
    badState.badDays >= 3 ||
    badState.badStreak >= 3
  ) {
    status = "red";
    bucketRank = 2;
  } else if (
    score >= 75 &&
    missedCritical === 0 &&
    player.badWarQualityCount === 0
  ) {
    status = "green";
    bucketRank = 4;
  } else {
    status = "yellow";
    bucketRank = 3;
  }

  const reasons = buildRatingReasons(player, {
    score,
    baseScore,
    confidence,
    missedCritical,
    avgStars,
    threeStarRate,
    topScoreBonus,
    perfectWarStreak,
    badDays: badState.badDays,
    badStreak: badState.badStreak,
  });
  const riskReasons = buildRiskReasons(player, {
    score,
    confidence,
    missedCritical,
    avgStars,
    badDays: badState.badDays,
    badStreak: badState.badStreak,
  });

  return {
    ...player,
    reasons,
    riskReasons,
    score,
    ratingScore: score,
    baseScore,
    confidence,
    eventsCount: player.events,
    avgStars,
    avgDestruction,
    missedCritical,
    totalMissed,
    usageRate,
    raidUsageRate,
    threeStarRate,
    warReliabilityRate,
    badDays: badState.badDays,
    badStreak: badState.badStreak,
    lastBadDate: badState.lastBadDate,
	    perfectWarStreak,
	    topScoreBonus,
	    recentEvents: player.recentEvents.sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 8),
	    warAttacksUsed: player.warAttacksUsed,
    warAttacksAvailable: player.warAttacksAvailable,
    missedWarAttacks: missedCritical,
    status,
    bucketRank,
  };
}

function getRatingDateKey(value) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function isBadRatingEvent(source, score, metrics) {
  const missed = numberOrZero(metrics.missed);
  if (source === "raid") return score < 60 || missed >= 3;
  return missed > 0 || Boolean(metrics.badWarQuality) || score < 60;
}

function calculateBadState(dateStats) {
  const dates = [...dateStats.values()].sort((a, b) => b.date.localeCompare(a.date));
  const badDays = dates.filter((item) => item.bad).length;
  const lastBad = dates.find((item) => item.bad);
  let badStreak = 0;

  for (const item of dates) {
    if (!item.bad) break;
    badStreak++;
  }

  return {
    badDays,
    badStreak,
    lastBadDate: lastBad ? lastBad.date : "",
  };
}

function calculatePerfectWarStreak(warHistory) {
  const wars = [...warHistory].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  let streak = 0;

  for (const war of wars) {
    if (!war.perfectWar) break;
    streak++;
  }

  return streak;
}

function hasSeveralBadWarEventsInRow(warHistory, threshold = 3) {
  const wars = [...warHistory].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  let streak = 0;

  for (const war of wars) {
    if (!war.badWarQuality && !war.missed && war.score >= 60) break;
    streak++;
    if (streak >= threshold) return true;
  }

  return false;
}

function buildRatingReasons(player, context) {
  const reasons = [];
  const missedPenalty = context.missedCritical * 20;
  const badQualityPenalty = player.badWarQualityCount >= 3 ? 20 : player.badWarQualityCount >= 2 ? 10 : player.badWarQualityCount === 1 ? 8 : 0;

  if (player.events === 0) return ["новых данных по игроку пока нет"];
  if (context.confidence === "low") {
    reasons.push(context.missedCritical || player.badWarQualityCount
      ? "данных мало, но есть риск - нужна повторная проверка позже"
      : "данных мало, рейтинг предварительный");
  }
  if (missedPenalty > 0) reasons.push(`-${missedPenalty} за пропущенные атаки КВ/ЛВК`);
  if (player.badWarQualityCount > 0) reasons.push(`-${badQualityPenalty} за ${pluralRu(player.badWarQualityCount, "плохую войну без 3⭐", "плохие войны без 3⭐", "плохих войн без 3⭐")}`);
  if (player.attackSamples >= 2 && context.avgStars < 2) reasons.push("-10 за средние звёзды ниже 2.0");
  if (context.badDays >= 3) reasons.push(`плохое состояние ${context.badDays} дня`);
  if (context.badStreak >= 3) reasons.push(`серия плохого состояния ${context.badStreak} дня`);
  if (player.perfectWarCount > 0) reasons.push(`+${Math.min(player.perfectWarCount * 8, 24)} за ${pluralRu(player.perfectWarCount, "идеальную войну 3⭐+3⭐", "идеальные войны 3⭐+3⭐", "идеальных войн 3⭐+3⭐")}`);
  if (context.perfectWarStreak >= 3) reasons.push("+10 за серию 3+ идеальных войн");
  else if (context.perfectWarStreak >= 2) reasons.push("+5 за серию 2 идеальных войн");
  if (player.attackSamples >= 4 && context.threeStarRate >= 70) reasons.push("+10 за высокий процент 3⭐");
  if (player.attacksPossible > 0 && context.missedCritical === 0) reasons.push("+8 за отсутствие пропусков КВ/ЛВК");
  if (player.raidEvents > 0 && player.raidMissed === 0 && player.raidAttacksUsed > 0) reasons.push("+6 за закрытые рейды");
  if (!reasons.length) reasons.push("стабильно закрывает активности");

  return reasons.slice(0, 6);
}

function buildRiskReasons(player, context) {
  const reasons = [];

  if (player.events === 0) return ["новых данных по игроку пока нет"];
  if (context.confidence === "low") reasons.push("данных мало, вывод предварительный");
  if (context.missedCritical > 0) reasons.push(`пропущено атак КВ/ЛВК: ${context.missedCritical}`);
  if (player.badWarQualityCount > 0) reasons.push(`плохих войн без 3⭐: ${player.badWarQualityCount}`);
  if (context.badDays > 0) reasons.push(`плохое состояние: ${context.badDays} дн.`);
  if (context.badStreak > 0) reasons.push(`серия: ${context.badStreak}`);
  if (player.raidMissed > 0) reasons.push(`рейд-пропусков: ${player.raidMissed}`);
  if (!reasons.length && context.score < 75) reasons.push("низкий общий рейтинг");

  return reasons;
}

function getRatingStatusIcon(status) {
  const icons = {
    top: "🏆",
    green: "🟢",
    yellow: "🟡",
    red: "🔴",
    low_data: "🟦",
    low_risk: "🟦",
    no_data: "⬜",
  };
  return icons[status] || "•";
}

function confidenceLabel(confidence) {
  if (confidence === "high") return "высокая";
  if (confidence === "medium") return "средняя";
  return "низкая";
}

function sourceLabel(source) {
  if (source === "war") return "КВ";
  if (source === "cwl") return "ЛВК";
  if (source === "raid") return "рейды";
  return source || "событие";
}

function normalizeSearchText(value) {
  return String(value || "").trim().toLowerCase().replace(/ё/g, "е");
}

function pluralRu(value, one, few, many) {
  const number = Math.abs(Number(value || 0));
  const mod10 = number % 10;
  const mod100 = number % 100;
  if (mod10 === 1 && mod100 !== 11) return `${number} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${number} ${few}`;
  return `${number} ${many}`;
}

function compareTopPlayers(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.perfectWarCount !== b.perfectWarCount) return b.perfectWarCount - a.perfectWarCount;
  if (a.threeStarRate !== b.threeStarRate) return b.threeStarRate - a.threeStarRate;
  if (a.missedCritical !== b.missedCritical) return a.missedCritical - b.missedCritical;
  return a.name.localeCompare(b.name);
}

function formatRatingScore(player) {
  return player && player.eventsCount > 0 ? `${player.score}/100` : "нет оценки";
}

function renderRatingReport(report, mode = "rating", env = {}, options = {}) {
  if (!report.players.length) {
    return [
      "🧮 <b>Рейтинг клана</b>",
      "",
      `За последние <b>${report.days}</b> дней данных пока нет.`,
      "Бот начнёт считать рейтинг после сохранённых КВ/ЛВК/рейдов.",
    ].join("\n");
  }

  if (mode === "weak") return renderWeakReport(report);
  if (mode === "missed") return renderMissedReport(report);
  if (options.view === "short") return renderRatingShortReport(report, env);

  const top = report.players.filter((player) => player.status === "top").sort(compareTopPlayers);
  const green = report.players.filter((player) => player.status === "green");
  const yellow = report.players.filter((player) => player.status === "yellow");
  const red = report.players.filter((player) => player.status === "red");
  const lowData = report.players.filter((player) => player.status === "low_data" && player.eventsCount > 0);
  const lowRisk = report.players.filter((player) => player.status === "low_risk");
  const noData = report.players.filter((player) => player.status === "no_data" || player.eventsCount === 0);
  const hasLowConfidence = report.players.some((player) => player.confidence === "low");
  const dataStatus = hasLowConfidence || report.eventCount < report.players.length * 3
    ? "мало данных, рейтинг предварительный"
    : "данных достаточно для рабочих выводов";

  const lines = [
    `🧮 <b>Рейтинг клана за ${report.days} дней</b>`,
    "",
    `Игроков: <b>${report.players.length}</b>`,
    `Записей: <b>${report.eventCount}</b>`,
    report.ratingSince ? `Новые данные с: <b>${escapeHtml(formatIsoDateTime(report.ratingSince, env))}</b>` : "",
    `Статус данных: <b>${escapeHtml(dataStatus)}</b>`,
    "",
    "Что значат цифры:",
    "Рейтинг - общая полезность игрока 0-100",
    "Данные - сколько событий учтено",
    "КВ/ЛВК - использованные атаки / доступные атаки",
    "3⭐ - количество атак на 3 звезды",
    "Пропуски - неиспользованные атаки",
    "Рейды - использованные атаки в рейдах",
    "Плохое состояние - сколько дней игрок был в жёлтой/красной зоне",
    "Серия - сколько дней подряд игрок в плохом состоянии",
    "",
  ].filter((line) => line !== "");

  lines.push("🏆 <b>Топ игроков</b>");
  for (const player of top) lines.push(renderTopPlayerLine(player));
  if (!top.length) lines.push("— пока пусто");

  lines.push("", "🟢 <b>Надёжные</b>");
  for (const player of green) lines.push(renderRatingPlayerLine(player, true));
  if (!green.length) lines.push("— пока пусто");

  lines.push("", "🟡 <b>Под контролем</b>");
  for (const player of yellow) lines.push(renderRatingPlayerLine(player, true));
  if (!yellow.length) lines.push("— пока пусто");

  lines.push("", "🔴 <b>Кандидаты на проверку</b>");
  for (const player of red) lines.push(renderRatingPlayerLine(player, true));
  if (!red.length) lines.push("— пока пусто");

  lines.push("", "🟦 <b>Мало данных</b>");
  for (const player of lowData) lines.push(renderRatingPlayerLine(player, true));
  if (!lowData.length) lines.push("— пока пусто");

  lines.push("", "🟦 <b>Мало данных, есть риск</b>");
  for (const player of lowRisk) lines.push(renderRatingPlayerLine(player, true, true));
  if (!lowRisk.length) lines.push("— пока пусто");

  lines.push("", "⬜ <b>Нет новых данных</b>");
  for (const player of noData) lines.push(renderNoDataPlayerLine(player));
  if (!noData.length) lines.push("— пока пусто");

  lines.push("", "Команды админа: <code>/weak 14</code>, <code>/missed 14</code>.");
  return lines.join("\n");
}

function renderRatingShortReport(report, env = {}) {
  const top = report.players
    .filter((player) => player.status === "top")
    .sort(compareTopPlayers)
    .slice(0, 10);
  const urgent = report.players
    .filter((player) => player.status === "red")
    .sort((a, b) => a.score - b.score || b.missedCritical - a.missedCritical);
  const watch = report.players
    .filter((player) => player.status === "yellow")
    .sort((a, b) => a.score - b.score || b.badWarQualityCount - a.badWarQualityCount)
    .slice(0, 10);
  const lowRisk = report.players
    .filter((player) => player.status === "low_risk")
    .sort((a, b) => a.score - b.score || b.totalMissed - a.totalMissed);
  const lowDataCount = report.players.filter((player) => player.status === "low_data" && player.eventsCount > 0).length;
  const noDataCount = report.players.filter((player) => player.eventsCount === 0).length;

  const lines = [
    `📌 <b>Короткий рейтинг за ${report.days} дней</b>`,
    "",
    `Игроков: <b>${report.players.length}</b>, записей: <b>${report.eventCount}</b>`,
    report.ratingSince ? `Новые данные с: <b>${escapeHtml(formatIsoDateTime(report.ratingSince, env))}</b>` : "",
    "",
    "🏆 <b>Топ</b>",
  ].filter((line) => line !== "");

  if (top.length) {
    for (const player of top) lines.push(`• ${escapeHtml(player.name)} — <b>${formatRatingScore(player)}</b>, 3⭐ <b>${player.threeStarAttacks}</b>, идеальные войны <b>${player.perfectWarCount}</b>`);
  } else {
    lines.push("— пока пусто");
  }

  lines.push("", "🔴 <b>Срочно проверить</b>");
  if (urgent.length) {
    for (const player of urgent) lines.push(`• ${escapeHtml(player.name)} — <b>${formatRatingScore(player)}</b>; ${escapeHtml(player.riskReasons.join("; ") || player.reasons.join("; "))}`);
  } else {
    lines.push("— пока пусто");
  }

  lines.push("", "🟡 <b>Под контролем</b>");
  if (watch.length) {
    for (const player of watch) lines.push(`• ${escapeHtml(player.name)} — <b>${formatRatingScore(player)}</b>; ${escapeHtml(player.riskReasons.join("; ") || player.reasons.join("; "))}`);
  } else {
    lines.push("— пока пусто");
  }

  lines.push("", "🟦 <b>Мало данных, есть риск</b>");
  if (lowRisk.length) {
    for (const player of lowRisk) lines.push(`• ${escapeHtml(player.name)} — <b>${formatRatingScore(player)}</b>; ${escapeHtml(player.riskReasons.join("; ") || player.reasons.join("; "))}`);
  } else {
    lines.push("— пока пусто");
  }

  lines.push("", `🟦 Мало данных без риска: <b>${lowDataCount}</b>`);
  lines.push(`⬜ Нет новых данных: <b>${noDataCount}</b>`);
  lines.push("", "Полный отчёт: <code>/rating full</code>");

  return lines.join("\n");
}

function renderWeakReport(report) {
  const urgent = report.players
    .filter((player) => player.status === "red")
    .sort((a, b) => a.score - b.score || b.missedCritical - a.missedCritical || b.badDays - a.badDays);
  const watch = report.players
    .filter((player) => player.status === "yellow")
    .sort((a, b) => a.score - b.score || b.badWarQualityCount - a.badWarQualityCount);
  const lowRisk = report.players
    .filter((player) => player.status === "low_risk")
    .sort((a, b) => a.score - b.score || b.missedCritical - a.missedCritical);

  const lines = [
    `🔴 <b>Слабые места за ${report.days} дней</b>`,
    "",
    "Это не автокик, а список для главы: проверь контекст, донаты, роли и предупреждения.",
    "",
  ];

  lines.push("🔴 <b>Срочно проверить</b>");
  for (const player of urgent) lines.push(renderWeakPlayerLine(player));
  if (!urgent.length) lines.push("— пока пусто");

  lines.push("", "🟡 <b>Под контролем</b>");
  for (const player of watch) lines.push(renderWeakPlayerLine(player));
  if (!watch.length) lines.push("— пока пусто");

  lines.push("", "🟦 <b>Мало данных, но есть риск</b>");
  for (const player of lowRisk) lines.push(renderWeakPlayerLine(player, true));
  if (!lowRisk.length) lines.push("— пока пусто");

  return lines.join("\n");
}

function renderMissedReport(report) {
  const missed = report.players
    .filter((player) => player.totalMissed > 0)
    .sort((a, b) => b.totalMissed - a.totalMissed || a.score - b.score);

  const lines = [`⚠️ <b>Пропуски за ${report.days} дней</b>`, ""];

  if (!missed.length) {
    lines.push("По накопленным данным пропусков нет.");
    return lines.join("\n");
  }

  for (const player of missed) {
    lines.push(renderMissedPlayerLine(player));
  }

  return lines.join("\n");
}

function renderTopPlayerLine(player) {
  const reasons = [];
  if (player.perfectWarCount > 0) reasons.push("стабильные 3⭐+3⭐");
  if (player.threeStarRate >= 70) reasons.push("высокий процент 3⭐");
  if (player.missedCritical === 0) reasons.push("нет пропусков");

  return [
    `• <b>${escapeHtml(player.name)}</b> — <b>${formatRatingScore(player)}</b>`,
    `  КВ/ЛВК: <b>${player.warAttacksUsed}/${player.warAttacksAvailable}</b> атак, 3⭐ <b>${player.threeStarAttacks}</b>`,
    `  Идеальные войны: <b>${player.perfectWarCount}</b>, серия: <b>${player.perfectWarStreak}</b>`,
    `  Причины: ${escapeHtml(reasons.join(", ") || player.reasons.join("; "))}`,
  ].join("\n");
}

function renderWeakPlayerLine(player, lowConfidence = false) {
  const lines = [
    `• <b>${escapeHtml(player.name)}</b> — <b>${formatRatingScore(player)}</b>`,
  ];

  if (lowConfidence) lines.push(`  Данные: ${pluralRu(player.eventsCount, "событие", "события", "событий")}`);
  lines.push(`  КВ/ЛВК: <b>${player.warAttacksUsed}/${player.warAttacksAvailable}</b>, 3⭐ <b>${player.threeStarAttacks}</b>, пропуски <b>${player.missedCritical}</b>`);
  lines.push(`  Плохое состояние: <b>${player.badDays}</b> ${pluralRu(player.badDays, "день", "дня", "дней").replace(/^\d+\s/, "")}, серия: <b>${player.badStreak}</b>`);
  lines.push(`  Причины: ${escapeHtml((player.riskReasons.length ? player.riskReasons : player.reasons).join("; "))}`);

  return lines.join("\n");
}

function renderMissedPlayerLine(player) {
  return [
    `• <b>${escapeHtml(player.name)}</b> — рейтинг <b>${formatRatingScore(player)}</b>`,
    `  КВ: пропущено <b>${player.warMissed}</b>`,
    `  ЛВК: пропущено <b>${player.cwlMissed}</b>`,
    `  Рейды: пропущено <b>${player.raidMissed}</b>`,
    `  Плохое состояние: <b>${player.badDays}</b> ${pluralRu(player.badDays, "день", "дня", "дней").replace(/^\d+\s/, "")}, серия: <b>${player.badStreak}</b>`,
    `  Причины: ${escapeHtml((player.riskReasons.length ? player.riskReasons : player.reasons).join("; "))}`,
  ].join("\n");
}

function renderPlayerRatingCard(player, report, env = {}) {
  const lines = [
    `👤 <b>${escapeHtml(player.name)}</b>`,
    "",
    `Рейтинг: <b>${formatRatingScore(player)}</b>`,
    `Группа: <b>${escapeHtml(formatPlayerStatus(player.status))}</b>`,
    `Данные: <b>${pluralRu(player.eventsCount, "событие", "события", "событий")}</b>, достоверность: <b>${confidenceLabel(player.confidence)}</b>`,
    report.ratingSince ? `Новые данные с: <b>${escapeHtml(formatIsoDateTime(report.ratingSince, env))}</b>` : "",
    "",
    `КВ/ЛВК: <b>${player.warAttacksUsed}/${player.warAttacksAvailable}</b>, 3⭐ <b>${player.threeStarAttacks}</b>, пропуски <b>${player.missedCritical}</b>`,
    `Качество: идеальные войны <b>${player.perfectWarCount}</b>, серия <b>${player.perfectWarStreak}</b>, 3⭐ <b>${player.threeStarRate.toFixed(0)}%</b>`,
    `Рейды: <b>${player.raidAttacksUsed}/${player.raidAttacksPossible}</b>, пропуски <b>${player.raidMissed}</b>, сезонов <b>${player.raidEvents}</b>`,
    `Плохое состояние: <b>${player.badDays}</b> ${pluralRu(player.badDays, "день", "дня", "дней").replace(/^\d+\s/, "")}, серия <b>${player.badStreak}</b>`,
    "",
    `Причины: ${escapeHtml(player.reasons.join("; "))}`,
    "",
    "Последние события:",
  ].filter((line) => line !== "");

  if (!player.recentEvents.length) {
    lines.push("— новых завершённых событий пока нет");
  } else {
    for (const event of player.recentEvents.slice(0, 6)) {
      lines.push(renderRecentRatingEvent(event, env));
    }
  }

  return lines.join("\n");
}

function formatPlayerStatus(status) {
  const labels = {
    top: "топ",
    green: "надёжный",
    yellow: "под контролем",
    red: "кандидат на проверку",
    low_data: "мало данных",
    low_risk: "мало данных, есть риск",
    no_data: "нет новых данных",
  };
  return labels[status] || status || "-";
}

function renderRecentRatingEvent(event, env = {}) {
  const metrics = event.metrics || {};
  const parts = [
    `• ${escapeHtml(sourceLabel(event.source))}`,
    formatIsoDateTime(event.time, env),
    `${event.score}/100`,
  ];

  if (event.source === "raid") {
    parts.push(`рейды ${numberOrZero(metrics.used)}/${numberOrZero(metrics.possible)}`);
    if (numberOrZero(metrics.missed)) parts.push(`пропуски ${numberOrZero(metrics.missed)}`);
  } else {
    parts.push(`атаки ${numberOrZero(metrics.used)}/${numberOrZero(metrics.possible)}`);
    parts.push(`3⭐ ${numberOrZero(metrics.triples)}`);
    if (numberOrZero(metrics.missed)) parts.push(`пропуски ${numberOrZero(metrics.missed)}`);
  }

  return parts.join(" — ");
}

function renderNoDataPlayerLine(player) {
  return `• ⬜ <b>${escapeHtml(player.name)}</b> — <b>нет оценки</b>\n  Причины: новых завершённых событий новой версии пока нет`;
}

function renderRatingPlayerLine(player, withReasons = false, riskOnly = false) {
  const icon = getRatingStatusIcon(player.status);
  const lines = [
    `• ${icon} <b>${escapeHtml(player.name)}</b> — <b>${formatRatingScore(player)}</b>`,
    `  Данные: ${pluralRu(player.eventsCount, "событие", "события", "событий")}, достоверность: ${confidenceLabel(player.confidence)}`,
  ];

  if (player.warAttacksAvailable) {
    const warLine = [`  КВ/ЛВК: атаки <b>${player.warAttacksUsed}/${player.warAttacksAvailable}</b>, 3⭐ <b>${player.threeStarAttacks}</b>`];
    if (player.missedCritical) warLine.push(`пропуски <b>${player.missedCritical}</b>`);
    lines.push(warLine.join(", "));
  }

  if (player.perfectWarCount || player.goodWarCount) {
    lines.push(`  Качество: ${pluralRu(player.perfectWarCount, "война", "войны", "войн")} с 3⭐+3⭐, хороших войн: <b>${player.goodWarCount}</b>, 3⭐: <b>${player.threeStarRate.toFixed(0)}%</b>`);
  }

  if (player.raidAttacksPossible) {
    const raidEventsText = player.raidEvents ? `, сезонов: <b>${player.raidEvents}</b>` : "";
    lines.push(`  Рейды: <b>${player.raidAttacksUsed}/${player.raidAttacksPossible}</b>${raidEventsText}`);
  }
  lines.push(`  Плохое состояние: <b>${player.badDays}</b> ${pluralRu(player.badDays, "день", "дня", "дней").replace(/^\d+\s/, "")}, серия: <b>${player.badStreak}</b>`);

  if (withReasons) {
    const reasons = riskOnly && player.riskReasons.length ? player.riskReasons : player.reasons;
    lines.push(`  Причины: ${escapeHtml(reasons.join("; "))}`);
  }

  return lines.join("\n");
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

/* -------------------------------------------------------------------------- */
/* Cron                                                                        */
/* -------------------------------------------------------------------------- */

async function handleCron(env) {
  try {
    const results = await runAllWatchers(env, { notify: true });
    console.log("Cron watcher result:", results);
  } catch (e) {
    console.error("Cron watcher error:", e);
  }
}

async function runAllWatchers(env, options = {}) {
  const results = {};

  if (String(env.AUTO_WAR_ENABLED || "true").toLowerCase() !== "false") {
    results.war = await safeWatcher("war", () => runWarWatcher(env, options));
  }

  if (String(env.AUTO_CWL_ENABLED || "true").toLowerCase() !== "false") {
    results.cwl = await safeWatcher("cwl", () => runCwlWatcher(env, options));
  }

  if (String(env.AUTO_RAID_ENABLED || "true").toLowerCase() !== "false") {
    results.raid = await safeWatcher("raid", () => runRaidWatcher(env, options));
  }

  if (String(env.AUTO_RATING_ENABLED || "true").toLowerCase() !== "false" && options.notify !== false && !options.manual) {
    results.rating = await safeWatcher("rating", () => maybeSendScheduledRatingReport(env));
  }

  return results;
}

async function safeWatcher(name, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(`${name} watcher failed:`, e);
    return { ok: false, error: e.message || String(e) };
  }
}

/* -------------------------------------------------------------------------- */
/* Generic D1 state                                                            */
/* -------------------------------------------------------------------------- */

async function ensureRuntimeTables(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS bot_states (
      chat_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS bot_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      state TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS player_events (
      event_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      player_tag TEXT NOT NULL,
      player_name TEXT NOT NULL,
      event_time TEXT NOT NULL,
      score REAL NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_player_events_time
    ON player_events (event_time)
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_player_events_player
    ON player_events (player_tag, event_time)
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS player_links (
      tg_user_id TEXT NOT NULL,
      tg_username TEXT,
      player_tag TEXT NOT NULL,
      player_name TEXT,
      town_hall_level INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (tg_user_id, player_tag)
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_player_links_tag
    ON player_links (player_tag)
  `).run();
}

async function getBotSetting(db, key) {
  await ensureRuntimeTables(db);
  const row = await db.prepare("SELECT value FROM bot_settings WHERE key = ?").bind(key).first();
  return row && row.value ? String(row.value) : "";
}

async function setBotSetting(db, key, value) {
  await ensureRuntimeTables(db);
  await db.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).bind(key, String(value || ""), new Date().toISOString()).run();
}

async function getEventRecord(db, eventId) {
  await ensureRuntimeTables(db);
  return db.prepare("SELECT * FROM bot_events WHERE event_id = ?").bind(eventId).first();
}

async function upsertEventRecord(db, eventId, type, state, rawJson) {
  await ensureRuntimeTables(db);
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO bot_events (event_id, type, state, raw_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET
      type = excluded.type,
      state = excluded.state,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).bind(eventId, type, state || "", JSON.stringify(rawJson || {}), now, now).run();
}

/* -------------------------------------------------------------------------- */
/* War watcher                                                                 */
/* -------------------------------------------------------------------------- */

async function runWarWatcher(env, options = {}) {
  const notify = options.notify !== false;
  const target = await resolveNotificationTarget(env, options);
  const chatId = target.chatId;

  if (!env.DB) throw new Error("D1 binding DB is missing");
  await ensureRuntimeTables(env.DB);

  const war = await getCurrentWar(env);

  if (!war || war.state === "notInWar") {
    return { ok: true, state: "notInWar", insertedAttacks: 0, notifiedAttacks: 0 };
  }

  return processWarLikeObject(env, chatId, war, {
    notify,
    type: "war",
    titleNew: "⚔️ <b>КВ найдена</b>",
    titleStarted: "⚔️ <b>КВ началась!</b>",
    titleEnded: "🏁 <b>КВ закончилась!</b>",
    timers: true,
    notificationTarget: target,
  });
}

async function processWarLikeObject(env, chatId, war, config = {}) {
  const warId = getWarId(war, config.type || "war");
  const previous = await getWarRecord(env.DB, warId);
  const notificationTarget = config.notificationTarget || { chatId };
  const firstSeen = !previous;
  const previousState = previous && previous.state ? previous.state : "";
  const notify = config.notify !== false;
  const attacks = collectWarAttacks(war, config.type || "war");
  const ratingSince = await getRatingEpoch(env.DB);
  let insertedAttacks = 0;
  let notifiedAttacks = 0;
  let stateNotified = false;
  let timerNotified = false;

  if (firstSeen) {
    for (const attack of attacks) {
      const inserted = await insertAttackIfNew(env.DB, warId, attack);
      if (inserted) insertedAttacks++;
    }

    await upsertWarRecord(env.DB, warId, war);
    await recordWarRatingEvents(env.DB, war, config.type || "war", { ratingSince });

    if (notify && chatId) {
      await tgSendNotification(env, renderWarAnnouncement(war, env, config.titleNew), { parse_mode: "HTML" }, notificationTarget);
    }

    return { ok: true, state: war.state, warId, firstSeen: true, insertedAttacks, notifiedAttacks };
  }

  await upsertWarRecord(env.DB, warId, war);
  await recordWarRatingEvents(env.DB, war, config.type || "war", { ratingSince });

  if (notify && chatId && previousState && previousState !== war.state) {
    stateNotified = await notifyWarStateChanged(env, chatId, war, previousState, config);
  }

  const newAttacks = [];
  for (const attack of attacks.sort((a, b) => a.orderNo - b.orderNo)) {
    const inserted = await insertAttackIfNew(env.DB, warId, attack);
    if (!inserted) continue;
    insertedAttacks++;
    newAttacks.push(attack);
  }

  if (notify && chatId && newAttacks.length) {
    await tgSendNotification(env, renderAttackBatchMessage(war, newAttacks, env, config.type || "war"), { parse_mode: "HTML" }, notificationTarget);
    notifiedAttacks = newAttacks.length;
  }

  if (notify && chatId && config.timers !== false) {
    timerNotified = await maybeSendWarTimers(env, chatId, war, { skipPeriodicTodo: stateNotified || notifiedAttacks > 0, prefix: config.type || "war", notificationTarget });
  }

  return { ok: true, state: war.state, warId, firstSeen: false, insertedAttacks, notifiedAttacks, stateNotified, timerNotified };
}

function getWarId(war, prefix = "war") {
  const clanTag = war && war.clan && war.clan.tag ? war.clan.tag : "unknownClan";
  const opponentTag = war && war.opponent && war.opponent.tag ? war.opponent.tag : "unknownOpponent";
  const startTime = war && war.startTime ? war.startTime : "unknownStart";
  const warTag = war && war.warTag ? war.warTag : "";
  return `${prefix}:${warTag || `${clanTag}:${opponentTag}:${startTime}`}`;
}

async function getWarRecord(db, warId) {
  return db.prepare("SELECT * FROM wars WHERE war_id = ?").bind(warId).first();
}

async function upsertWarRecord(db, warId, war) {
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO wars (
      war_id, clan_tag, opponent_tag, opponent_name, state,
      preparation_start_time, start_time, end_time, attacks_per_member,
      raw_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(war_id) DO UPDATE SET
      clan_tag = excluded.clan_tag,
      opponent_tag = excluded.opponent_tag,
      opponent_name = excluded.opponent_name,
      state = excluded.state,
      preparation_start_time = excluded.preparation_start_time,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      attacks_per_member = excluded.attacks_per_member,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `).bind(
    warId,
    war.clan && war.clan.tag ? war.clan.tag : "",
    war.opponent && war.opponent.tag ? war.opponent.tag : "",
    war.opponent && war.opponent.name ? war.opponent.name : "",
    war.state || "",
    war.preparationStartTime || "",
    war.startTime || "",
    war.endTime || "",
    Number(war.attacksPerMember || 0),
    JSON.stringify(war),
    now,
    now
  ).run();
}

function collectWarAttacks(war, prefix = "war") {
  const warId = getWarId(war, prefix);
  const ourMembers = (war.clan && war.clan.members) || [];
  const enemyMembers = (war.opponent && war.opponent.members) || [];
  const byTag = new Map();

  for (const member of ourMembers) byTag.set(member.tag, { ...member, side: "our" });
  for (const member of enemyMembers) byTag.set(member.tag, { ...member, side: "enemy" });

  const members = [
    ...ourMembers.map((member) => ({ ...member, side: "our" })),
    ...enemyMembers.map((member) => ({ ...member, side: "enemy" })),
  ];

  const attacks = [];

  for (const member of members) {
    for (const attack of member.attacks || []) {
      const attacker = byTag.get(attack.attackerTag) || member;
      const defender = byTag.get(attack.defenderTag) || {};
      const orderNo = Number(attack.order || 0);

      attacks.push({
        attackKey: `${warId}:${orderNo}:${attack.attackerTag || ""}:${attack.defenderTag || ""}`,
        warId,
        attackerTag: attack.attackerTag || "",
        attackerName: attacker.name || member.name || attack.attackerTag || "unknown",
        attackerSide: attacker.side || member.side || "unknown",
        defenderTag: attack.defenderTag || "",
        defenderName: defender.name || attack.defenderTag || "unknown",
        defenderSide: defender.side || "unknown",
        stars: Number(attack.stars || 0),
        destructionPercentage: Number(attack.destructionPercentage || 0),
        orderNo,
      });
    }
  }

  return attacks.sort((a, b) => a.orderNo - b.orderNo);
}

async function insertAttackIfNew(db, warId, attack) {
  const existing = await db.prepare("SELECT attack_key FROM attacks WHERE attack_key = ?").bind(attack.attackKey).first();
  if (existing) return false;

  try {
    await db.prepare(`
      INSERT INTO attacks (
        attack_key, war_id, attacker_tag, attacker_name, defender_tag, defender_name,
        stars, destruction_percentage, order_no, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      attack.attackKey,
      warId,
      attack.attackerTag,
      attack.attackerName,
      attack.defenderTag,
      attack.defenderName,
      attack.stars,
      attack.destructionPercentage,
      attack.orderNo,
      new Date().toISOString()
    ).run();

    return true;
  } catch (e) {
    if (String((e && e.message) || e).includes("UNIQUE")) return false;
    throw e;
  }
}

async function notifyWarStateChanged(env, chatId, war, previousState, config = {}) {
  const notificationTarget = config.notificationTarget || { chatId };

  if (war.state === "inWar") {
    await tgSendNotification(
      env,
      [config.titleStarted || "⚔️ <b>Война началась!</b>", "", renderScoreLine(war), "", renderAttacksLeftLine(war), "", renderTodoBlock(war, 40)].join("\n"),
      { parse_mode: "HTML" },
      notificationTarget
    );
    return true;
  }

  if (war.state === "warEnded") {
    await tgSendNotification(
      env,
      [config.titleEnded || "🏁 <b>Война закончилась!</b>", "", renderWarSummaryText(war, env)].join("\n"),
      { parse_mode: "HTML" },
      notificationTarget
    );
    return true;
  }

  if (war.state === "preparation") {
    await tgSendNotification(env, renderWarAnnouncement(war, env, config.titleNew), { parse_mode: "HTML" }, notificationTarget);
    return true;
  }

  console.log("War state changed:", { previousState, nextState: war.state });
  return false;
}

/* -------------------------------------------------------------------------- */
/* CWL watcher                                                                 */
/* -------------------------------------------------------------------------- */

async function runCwlWatcher(env, options = {}) {
  const notify = options.notify !== false;
  const target = await resolveNotificationTarget(env, options);
  const chatId = target.chatId;

  if (!env.DB) throw new Error("D1 binding DB is missing");
  await ensureRuntimeTables(env.DB);

  const group = await getCurrentCwlGroup(env);

  if (!group || group.state === "notInWar") return { ok: true, state: "notInWar" };

  const eventId = `cwl:${group.season || "unknown"}:${(group.clans || []).map((clan) => clan.tag).join(",")}`;
  const previous = await getEventRecord(env.DB, eventId);
  const firstSeen = !previous;

  await upsertEventRecord(env.DB, eventId, "cwl", group.state || "", group);

  if (firstSeen && notify && chatId) {
    await tgSendNotification(env, renderCwlFound(group), { parse_mode: "HTML" }, target);
  }

  const cwlWar = await getRelevantCwlWar(env, group).catch((e) => {
    console.error("CWL relevant war failed", e);
    return null;
  });

  if (!cwlWar) return { ok: true, state: group.state, firstSeen, war: false };

  const processed = await processWarLikeObject(env, chatId, cwlWar, {
    notify,
    type: "cwl",
    titleNew: "🏰 <b>Раунд ЛВК найден</b>",
    titleStarted: "🏰 <b>Раунд ЛВК начался!</b>",
    titleEnded: "🏁 <b>Раунд ЛВК закончился!</b>",
    timers: true,
    notificationTarget: target,
  });

  return { ok: true, state: group.state, firstSeen, war: processed };
}

function renderCwlFound(group) {
  return [
    "🏰 <b>ЛВК найдена</b>",
    "",
    `Сезон: <b>${escapeHtml(group.season || "-")}</b>`,
    `Статус: <b>${escapeHtml(formatCwlState(group.state))}</b>`,
    `Кланов: <b>${(group.clans || []).length}</b>`,
    "",
    "Бот будет отслеживать раунды, атаки и напоминания.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Raid watcher                                                                */
/* -------------------------------------------------------------------------- */

async function runRaidWatcher(env, options = {}) {
  const notify = options.notify !== false;
  const target = await resolveNotificationTarget(env, options);
  const chatId = target.chatId;

  if (!env.DB) throw new Error("D1 binding DB is missing");
  await ensureRuntimeTables(env.DB);

  const seasons = await getCapitalRaidSeasons(env, 1);
  const season = seasons[0];

  if (!season) return { ok: true, state: "notFound" };

  const eventId = getRaidEventId(season);
  const previous = await getEventRecord(env.DB, eventId);
  const firstSeen = !previous;
  const previousState = previous && previous.state ? previous.state : "";
  const previousRaw = previous && previous.raw_json ? safeJsonParse(previous.raw_json) : null;
  const ratingSince = await getRatingEpoch(env.DB);
  const rosterMembers = await getClanRosterForRating(env);

  await upsertEventRecord(env.DB, eventId, "raid", season.state || "", season);
  const ratingEvents = await recordRaidRatingEvents(env.DB, season, env, rosterMembers, { ratingSince });

  if (firstSeen && notify && chatId && season.state === "ongoing") {
    await tgSendNotification(env, ["🛖 <b>Рейд-уикенд начался</b>", "", renderRaidSeasonSummary(season, env, true)].join("\n"), { parse_mode: "HTML" }, target);
    await markReminderSent(env.DB, eventId, "raid_started");
    return { ok: true, state: season.state, firstSeen: true };
  }

  if (notify && chatId && previousState && previousState !== season.state) {
    if (season.state === "ended") {
      await tgSendNotification(env, ["🏁 <b>Рейд-уикенд закончился</b>", "", renderRaidSeasonSummary(season, env, true), "", renderRaidRatingAudit(season, rosterMembers, ratingEvents)].join("\n"), { parse_mode: "HTML" }, target);
      await markReminderSent(env.DB, eventId, "raid_ended");
      return { ok: true, state: season.state, changed: true, ratingEvents };
    }
  }

  if (notify && chatId && season.state === "ongoing") {
    const sentClosed = await maybeSendRaidAllClosedNotification(env, eventId, season, rosterMembers, target);
    if (sentClosed) return { ok: true, state: season.state, firstSeen, reminder: true, allClosed: true };

    const changedEnough = isRaidProgressChangedEnough(previousRaw, season);
    const sent = await maybeSendRaidPeriodicReminder(env, eventId, season, rosterMembers, changedEnough, target);
    return { ok: true, state: season.state, firstSeen, reminder: sent };
  }

  return { ok: true, state: season.state, firstSeen, ratingEvents };
}

function getRaidEventId(season) {
  return `raid:${season.startTime || "unknownStart"}:${season.endTime || "unknownEnd"}`;
}

function renderRaidRatingAudit(season, rosterMembers = [], ratingEvents = 0) {
  const members = mergeRaidMembersWithRoster(getRaidMembers(season), rosterMembers, season);
  const full = [];
  const partial = [];
  const zero = [];

  for (const member of members) {
    const used = numberOrZero(member.attacks);
    const possible = getRaidAttackLimit(member) || 6;
    const item = { name: member.name || member.tag || "unknown", used, possible };

    if (used <= 0) zero.push(item);
    else if (used >= possible) full.push(item);
    else partial.push(item);
  }

  const lines = [
    "🧮 <b>Аудит рейдов для рейтинга</b>",
    `Закрыли все атаки: <b>${full.length}</b>`,
    `Частично: <b>${partial.length}</b>`,
    `0 атак: <b>${zero.length}</b>`,
    `Новых записей рейтинга: <b>${ratingEvents}</b>`,
  ];

  if (partial.length) {
    lines.push("", "Частично:");
    for (const item of partial) lines.push(`• ${escapeHtml(item.name)} — <b>${item.used}/${item.possible}</b>`);
  }

  if (zero.length) {
    lines.push("", "0 атак:");
    for (const item of zero) lines.push(`• ${escapeHtml(item.name)} — <b>0/${item.possible}</b>`);
  }

  return lines.join("\n");
}

function renderRaidTodoReminder(season, todo, remainingMinutes, links = new Map(), env = {}) {
  const zero = todo.filter((item) => item.used === 0);
  const partial = todo.filter((item) => item.used > 0);
  const urgency = remainingMinutes <= 120 ? "Закрываем рейды, времени мало." : "Мягкое напоминание: добиваем атаки столицы.";
  const lines = [
    "🛖 <b>Хвосты рейдов столицы</b>",
    "",
    `До конца примерно: <b>${escapeHtml(formatMinutesHuman(remainingMinutes))}</b>`,
    urgency,
    "",
    renderRaidSeasonSummary(season, env, false),
  ];

  if (zero.length) {
    lines.push("", "0 атак:");
    for (const item of zero) lines.push(`• ${renderLinkedPlayerName(item, links)} — <b>0/${item.possible}</b>`);
  }

  if (partial.length) {
    lines.push("", "Частично:");
    for (const item of partial) lines.push(`• ${renderLinkedPlayerName(item, links)} — <b>${item.used}/${item.possible}</b>, осталось <b>${item.left}</b>`);
  }

  return lines.join("\n");
}

function renderRaidAllClosedMessage(season, rosterMembers = []) {
  const members = mergeRaidMembersWithRoster(getRaidMembers(season), rosterMembers, { ...(season || {}), state: "ended" });
  const closed = members.filter((member) => {
    const used = numberOrZero(member.attacks);
    const possible = getRaidAttackLimit(member) || 6;
    return used >= possible;
  }).length;

  return [
    "✅ <b>Рейды закрыты</b>",
    "",
    `Игроков закрыли атаки: <b>${closed}/${members.length}</b>`,
    `Золото: <b>${numberOrZero(season && season.capitalTotalLoot)}</b>`,
  ].join("\n");
}

function isRaidProgressChangedEnough(previous, current) {
  if (!previous) return false;
  const prevAttacks = numberOrZero(previous.totalAttacks);
  const nextAttacks = numberOrZero(current.totalAttacks);
  const prevLoot = numberOrZero(previous.capitalTotalLoot);
  const nextLoot = numberOrZero(current.capitalTotalLoot);
  return nextAttacks - prevAttacks >= 10 || nextLoot - prevLoot >= 5000;
}

async function maybeSendRaidAllClosedNotification(env, eventId, season, rosterMembers = [], notificationTarget = {}) {
  if (!rosterMembers.length) return false;

  const todo = collectRaidTodoMembers(season, rosterMembers);
  if (todo.length) return false;

  const kind = "raid_all_closed";
  if (await isReminderSent(env.DB, eventId, kind)) return false;

  await tgSendNotification(env, renderRaidAllClosedMessage(season, rosterMembers), { parse_mode: "HTML" }, notificationTarget);
  await markReminderSent(env.DB, eventId, kind);
  return true;
}

async function maybeSendRaidPeriodicReminder(env, eventId, season, rosterMembers = [], changedEnough, notificationTarget = {}) {
  const endTime = parseCocTime(season.endTime);
  const remainingMinutes = endTime ? Math.ceil((endTime.getTime() - Date.now()) / 60000) : 999999;

  if (remainingMinutes <= 0) return false;

  const todo = collectRaidTodoMembers(season, rosterMembers);
  if (!todo.length) return false;

  const threshold = getActiveReminderThreshold(remainingMinutes, [1440, 720, 360, 120]);
  const signature = hashString(todo.map((item) => `${normalizeTag(item.tag)}:${item.used}/${item.possible}`).join("|"));
  const bucket = Math.floor(Date.now() / ((remainingMinutes <= 120 ? 60 : 180) * 60000));
  const kind = threshold
    ? `raid_todo_${threshold}_${signature}`
    : changedEnough
      ? `raid_progress_${bucket}_${signature}`
      : `raid_periodic_${bucket}_${signature}`;

  if (await isReminderSent(env.DB, eventId, kind)) return false;

  const links = await getPlayerLinksByTags(env.DB, todo.map((item) => item.tag));
  await tgSendNotification(env, renderRaidTodoReminder(season, todo, remainingMinutes, links, env), { parse_mode: "HTML" }, notificationTarget);
  await markReminderSent(env.DB, eventId, kind);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Timers                                                                      */
/* -------------------------------------------------------------------------- */

async function maybeSendWarTimers(env, chatId, war, options = {}) {
  if (!war || !war.state) return false;

  const prefix = options.prefix || "war";
  const notificationTarget = options.notificationTarget || { chatId };

  if (war.state === "preparation") {
    return maybeSendTimeReminder(env, chatId, war, {
      type: `${prefix}_start`,
      target: parseCocTime(war.startTime),
      thresholds: [360, 180, 60, 15],
      notificationTarget,
    });
  }

  if (war.state === "inWar") {
    const closedSent = await maybeSendWarAllClosedNotification(env, war, prefix, notificationTarget);
    if (closedSent) return true;

    const sentImportantTimer = await maybeSendWarTodoThresholdReminder(env, war, prefix, notificationTarget);
    if (sentImportantTimer) return true;
    if (options.skipPeriodicTodo) return false;

    return maybeSendPeriodicTodoReminder(env, war, prefix, notificationTarget);
  }

  return false;
}

async function maybeSendWarAllClosedNotification(env, war, prefix = "war", notificationTarget = {}) {
  const members = (war.clan && war.clan.members) || [];
  const attacksPerMember = numberOrZero(war.attacksPerMember);
  const todo = collectWarTodoMembers(members, attacksPerMember);
  if (todo.length) return false;

  const warId = getWarId(war, prefix);
  const kind = `${prefix}_all_closed`;
  if (await isReminderSent(env.DB, warId, kind)) return false;

  await tgSendNotification(env, renderWarAllClosedMessage(war, prefix), { parse_mode: "HTML" }, notificationTarget);
  await markReminderSent(env.DB, warId, kind);
  return true;
}

async function maybeSendWarTodoThresholdReminder(env, war, prefix = "war", notificationTarget = {}) {
  const endTime = parseCocTime(war.endTime);
  if (!endTime) return false;

  const remainingMinutes = Math.ceil((endTime.getTime() - Date.now()) / 60000);
  if (remainingMinutes <= 0) return false;

  const thresholds = [720, 360, 120, 30];
  const threshold = getActiveReminderThreshold(remainingMinutes, thresholds);
  if (!threshold) return false;

  const members = (war.clan && war.clan.members) || [];
  const todo = collectWarTodoMembers(members, numberOrZero(war.attacksPerMember));
  if (!todo.length) return false;

  const warId = getWarId(war, prefix);
  const signature = hashString(todo.map((item) => `${normalizeTag(item.tag)}:${item.used}/${item.possible}`).join("|"));
  const kind = `${prefix}_todo_${threshold}_${signature}`;
  if (await isReminderSent(env.DB, warId, kind)) return false;

  const links = await getPlayerLinksByTags(env.DB, todo.map((item) => item.tag));
  await tgSendNotification(env, renderWarTodoReminder(war, todo, remainingMinutes, prefix, links, env), { parse_mode: "HTML" }, notificationTarget);
  await markReminderSent(env.DB, warId, kind);
  return true;
}

async function maybeSendTimeReminder(env, chatId, war, config) {
  if (!config.target) return false;

  const warId = getWarId(war, config.type.startsWith("cwl") ? "cwl" : "war");
  const remainingMinutes = Math.ceil((config.target.getTime() - Date.now()) / 60000);
  if (remainingMinutes <= 0) return false;

  const thresholds = [...config.thresholds].sort((a, b) => b - a);

  for (let i = 0; i < thresholds.length; i++) {
    const threshold = thresholds[i];
    const nextThreshold = thresholds[i + 1] || 0;

    if (remainingMinutes <= threshold && remainingMinutes > nextThreshold) {
      const kind = `${config.type}_${threshold}`;
      if (await isReminderSent(env.DB, warId, kind)) return false;

      const text = config.type.includes("start")
        ? renderStartReminder(war, remainingMinutes, env)
        : renderEndReminder(war, remainingMinutes, env);

      await tgSendNotification(env, text, { parse_mode: "HTML" }, config.notificationTarget || { chatId });
      await markReminderSent(env.DB, warId, kind);
      return true;
    }
  }

  return false;
}

async function maybeSendPeriodicTodoReminder(env, war, prefix = "war", notificationTarget = {}) {
  if (String(env.PERIODIC_TODO_ENABLED || "true").toLowerCase() === "false") return false;

  const todo = collectWarTodoMembers((war.clan && war.clan.members) || [], numberOrZero(war.attacksPerMember));
  if (!todo.length) return false;

  const endTime = parseCocTime(war.endTime);
  const remainingMinutes = endTime ? Math.ceil((endTime.getTime() - Date.now()) / 60000) : 999999;
  if (remainingMinutes <= 0) return false;

  const lateWindowMinutes = getNumberEnv(env, "TODO_REMINDER_LATE_WINDOW_MINUTES", 360);
  const earlyIntervalMinutes = getNumberEnv(env, "TODO_REMINDER_EARLY_MINUTES", 180);
  const lateIntervalMinutes = getNumberEnv(env, "TODO_REMINDER_LATE_MINUTES", 60);
  const intervalMinutes = remainingMinutes <= lateWindowMinutes ? lateIntervalMinutes : earlyIntervalMinutes;
  const bucket = Math.floor(Date.now() / (intervalMinutes * 60000));
  const signature = hashString(todo.map((item) => `${normalizeTag(item.tag)}:${item.used}/${item.possible}`).join("|"));
  const kind = `${prefix}_periodic_${intervalMinutes}_${bucket}_${signature}`;
  const warId = getWarId(war, prefix);

  if (await isReminderSent(env.DB, warId, kind)) return false;
  const links = await getPlayerLinksByTags(env.DB, todo.map((item) => item.tag));
  await tgSendNotification(env, renderWarTodoReminder(war, todo, remainingMinutes, prefix, links, env), { parse_mode: "HTML" }, notificationTarget);
  await markReminderSent(env.DB, warId, kind);
  return true;
}

async function isReminderSent(db, warId, kind) {
  const row = await db.prepare("SELECT kind FROM reminders WHERE war_id = ? AND kind = ?").bind(warId, kind).first();
  return Boolean(row);
}

async function markReminderSent(db, warId, kind) {
  await db.prepare("INSERT OR IGNORE INTO reminders (war_id, kind, sent_at) VALUES (?, ?, ?)").bind(warId, kind, new Date().toISOString()).run();
}

/* -------------------------------------------------------------------------- */
/* War rendering                                                               */
/* -------------------------------------------------------------------------- */

function renderWarStatus(war, env) {
  if (!war || war.state === "notInWar") return ["⚔️ <b>Текущая КВ</b>", "", "Клан сейчас не в КВ."].join("\n");

  const lines = [
    "⚔️ <b>Текущая КВ</b>",
    "",
    renderWarTitleLine(war),
    "",
    `Статус: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    `Размер: <b>${numberOrZero(war.teamSize)}x${numberOrZero(war.teamSize)}</b>`,
    `Атак на игрока: <b>${numberOrZero(war.attacksPerMember)}</b>`,
    "",
    renderScoreLine(war),
    renderDestructionLine(war),
    renderAttacksLeftLine(war),
  ];

  if (war.preparationStartTime) lines.push("", `Подготовка: <b>${escapeHtml(formatCocTime(war.preparationStartTime, env))}</b>`);
  if (war.startTime) lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  if (war.endTime) lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);

  lines.push("", renderTodoBlock(war, 40));
  return lines.join("\n");
}

function renderWarAnnouncement(war, env, title = "⚔️ <b>Война найдена</b>") {
  const opponent = war.opponent || {};
  const lines = [
    title,
    "",
    `Противник: <b>${escapeHtml(opponent.name || "неизвестно")}</b>`,
    `Тег: <code>${escapeHtml(opponent.tag || "-")}</code>`,
    `Статус: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    `Размер: <b>${numberOrZero(war.teamSize)}x${numberOrZero(war.teamSize)}</b>`,
    `Атак на игрока: <b>${numberOrZero(war.attacksPerMember)}</b>`,
  ];

  if (war.startTime) lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  if (war.endTime) lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);

  if (war.state === "preparation") lines.push("", "Бот напомнит перед началом.");
  if (war.state === "inWar") lines.push("", renderScoreLine(war), renderAttacksLeftLine(war), "", renderTodoBlock(war, 40));

  return lines.join("\n");
}

function renderAttackBatchMessage(war, attacks, env, type = "war") {
  const ourCount = attacks.filter((attack) => attack.attackerSide === "our").length;
  const enemyCount = attacks.filter((attack) => attack.attackerSide === "enemy").length;
  const title = type === "cwl" ? "🏰 <b>Новые атаки ЛВК</b>" : "⚔️ <b>Новые атаки</b>";
  const lines = [title, "", `Всего новых: <b>${attacks.length}</b>`];

  if (ourCount) lines.push(`Наших: <b>${ourCount}</b>`);
  if (enemyCount) lines.push(`Противника: <b>${enemyCount}</b>`);

  lines.push("");
  for (const attack of attacks.slice(-25)) lines.push(renderAttackLine(attack));
  if (attacks.length > 25) lines.push("", `Показаны последние 25 новых атак из ${attacks.length}.`);
  lines.push("", renderScoreLine(war), renderAttacksLeftLine(war));
  return lines.join("\n");
}

function renderAttackLine(attack) {
  const icon = attack.attackerSide === "our" ? "🔥" : "🛡";
  return [`${icon} #${attack.orderNo}`, `<b>${escapeHtml(attack.attackerName)}</b> → <b>${escapeHtml(attack.defenderName)}</b>`, `${renderStars(attack.stars)} ${formatPercent(attack.destructionPercentage)}`].join(" ");
}

function renderStartReminder(war, remainingMinutes, env) {
  const opponent = war.opponent || {};
  return [
    "⏳ <b>Скоро начнётся война</b>",
    "",
    `До начала примерно: <b>${escapeHtml(formatMinutesHuman(remainingMinutes))}</b>`,
    `Противник: <b>${escapeHtml(opponent.name || "неизвестно")}</b>`,
    war.startTime ? `Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>` : "",
    "",
    "Проверьте донаты, армии, героев и план атаки.",
  ].filter(Boolean).join("\n");
}

function renderEndReminder(war, remainingMinutes, env) {
  return [
    "⏰ <b>Скоро конец войны</b>",
    "",
    `До конца примерно: <b>${escapeHtml(formatMinutesHuman(remainingMinutes))}</b>`,
    "",
    renderScoreLine(war),
    renderAttacksLeftLine(war),
    "",
    renderTodoBlock(war, 40),
    "",
    war.endTime ? `Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>` : "",
  ].filter(Boolean).join("\n");
}

function renderPeriodicTodoReminder(war, remainingMinutes, env) {
  return ["🕒 <b>Контроль по атакам</b>", "", `До конца примерно: <b>${escapeHtml(formatMinutesHuman(remainingMinutes))}</b>`, "", renderScoreLine(war), renderAttacksLeftLine(war), "", renderTodoBlock(war, 50)].join("\n");
}

function renderWarTodoReminder(war, todo, remainingMinutes, prefix = "war", links = new Map(), env = {}) {
  const isCwl = prefix === "cwl";
  const title = isCwl ? "🏰 <b>Хвосты ЛВК</b>" : "⚔️ <b>Хвосты КВ</b>";
  const zero = todo.filter((item) => item.used === 0);
  const partial = todo.filter((item) => item.used > 0);
  const urgency = remainingMinutes <= 120 ? "Закрываем атаки, времени мало." : "Мягкое напоминание: проверьте армии и план.";
  const lines = [
    title,
    "",
    `До конца примерно: <b>${escapeHtml(formatMinutesHuman(remainingMinutes))}</b>`,
    urgency,
    "",
    renderScoreLine(war),
    renderAttacksLeftLine(war),
  ];

  if (zero.length) {
    lines.push("", `0/${isCwl ? 1 : 2}:`);
    for (const item of zero) lines.push(renderWarTodoMemberLine(item, links));
  }

  if (partial.length) {
    lines.push("", "Осталась часть атак:");
    for (const item of partial) lines.push(renderWarTodoMemberLine(item, links));
  }

  return lines.join("\n");
}

function renderWarAllClosedMessage(war, prefix = "war") {
  const title = prefix === "cwl" ? "✅ <b>Все атаки ЛВК закрыты</b>" : "✅ <b>Все атаки КВ закрыты</b>";
  return [title, "", renderScoreLine(war), renderAttacksLeftLine(war)].join("\n");
}

function renderWarSummaryText(war, env) {
  const lines = [
    "📊 <b>Сводка войны</b>",
    "",
    renderWarTitleLine(war),
    "",
    `Статус: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    renderScoreLine(war),
    renderDestructionLine(war),
    renderAttacksLeftLine(war),
  ];

  if (war.startTime) lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  if (war.endTime) lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);
  lines.push("", renderTodoBlock(war, 40));
  return lines.join("\n");
}

function renderWarTitleLine(war) {
  const ourClan = war.clan || {};
  const enemyClan = war.opponent || {};
  return `<b>${escapeHtml(ourClan.name || "Наш клан")}</b> vs <b>${escapeHtml(enemyClan.name || "Противник")}</b>`;
}

function renderScoreLine(war) {
  const ourClan = war.clan || {};
  const enemyClan = war.opponent || {};
  return `⭐ <b>${escapeHtml(ourClan.name || "Мы")}</b> ${numberOrZero(ourClan.stars)} — ${numberOrZero(enemyClan.stars)} <b>${escapeHtml(enemyClan.name || "Противник")}</b>`;
}

function renderDestructionLine(war) {
  const ourClan = war.clan || {};
  const enemyClan = war.opponent || {};
  return `💥 Разрушение: <b>${formatPercent(ourClan.destructionPercentage)}</b> — <b>${formatPercent(enemyClan.destructionPercentage)}</b>`;
}

function renderAttacksLeftLine(war) {
  const teamSize = numberOrZero(war.teamSize);
  const attacksPerMember = numberOrZero(war.attacksPerMember);
  const maxAttacks = teamSize * attacksPerMember;
  const ourUsed = countUsedAttacks((war.clan && war.clan.members) || []);
  const enemyUsed = countUsedAttacks((war.opponent && war.opponent.members) || []);
  return [`Наши атаки: <b>${ourUsed}/${maxAttacks}</b>, осталось <b>${Math.max(maxAttacks - ourUsed, 0)}</b>`, `Атаки противника: <b>${enemyUsed}/${maxAttacks}</b>, осталось <b>${Math.max(maxAttacks - enemyUsed, 0)}</b>`].join("\n");
}

function renderTodoBlock(war, limit = 40) {
  const ourMembers = (war.clan && war.clan.members) || [];
  const attacksPerMember = numberOrZero(war.attacksPerMember);
  const notAttacked = collectWarTodoMembers(ourMembers, attacksPerMember);

  if (!notAttacked.length) return "✅ <b>Все наши атаки использованы.</b>";

  const lines = ["🕒 <b>У кого остались атаки:</b>"];
  for (const item of notAttacked.slice(0, limit)) lines.push(renderWarTodoMemberLine(item));
  if (notAttacked.length > limit) lines.push(`…и ещё ${notAttacked.length - limit}`);
  return lines.join("\n");
}

function renderWarTodoMemberLine(item, links = new Map()) {
  const displayName = renderLinkedPlayerName(item, links);
  return `• #${item.mapPosition} ${displayName} — <b>${item.used}/${item.possible}</b>, осталось <b>${item.left}</b>`;
}

function renderLinkedPlayerName(item, links = new Map()) {
  const link = links.get(normalizeTag(item.tag));
  if (!link) return escapeHtml(item.name || item.tag || "unknown");
  if (link.tg_username) return `@${escapeHtml(link.tg_username)}`;
  if (link.tg_user_id) return `<a href="tg://user?id=${escapeHtml(link.tg_user_id)}">${escapeHtml(item.name || link.player_name || item.tag || "игрок")}</a>`;
  return escapeHtml(item.name || item.tag || "unknown");
}

function collectWarTodoMembers(members, attacksPerMember) {
  const max = Number(attacksPerMember || 0);
  if (!max) return [];

  return (members || []).map((member) => {
    const used = (member.attacks || []).length;
    return {
      tag: member.tag,
      name: member.name || member.tag || "unknown",
      used,
      possible: max,
      left: Math.max(max - used, 0),
      mapPosition: member.mapPosition || 999,
    };
  }).filter((member) => member.left > 0).sort((a, b) => {
    if (a.left !== b.left) return b.left - a.left;
    return a.mapPosition - b.mapPosition || a.name.localeCompare(b.name);
  });
}

function renderActivityTimeLine(activity, env) {
  if (!activity) return "";
  if (activity.state === "preparation" && activity.startTime) return `Начало: <b>${escapeHtml(formatCocTime(activity.startTime, env))}</b>`;
  if (activity.endTime) return `Конец: <b>${escapeHtml(formatCocTime(activity.endTime, env))}</b>`;
  return "";
}

function renderRaidTimeLine(season, env) {
  if (!season) return "";
  if (season.endTime) return `Конец: <b>${escapeHtml(formatCocTime(season.endTime, env))}</b>`;
  if (season.startTime) return `Старт: <b>${escapeHtml(formatCocTime(season.startTime, env))}</b>`;
  return "";
}

function getActiveReminderThreshold(remainingMinutes, thresholds) {
  const sorted = [...thresholds].sort((a, b) => b - a);
  for (let i = 0; i < sorted.length; i++) {
    const threshold = sorted[i];
    const nextThreshold = sorted[i + 1] || 0;
    if (remainingMinutes <= threshold && remainingMinutes > nextThreshold) return threshold;
  }
  return 0;
}

function hashString(value) {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function collectRaidTodoMembers(season, rosterMembers = []) {
  const members = mergeRaidMembersWithRoster(getRaidMembers(season), rosterMembers, { ...(season || {}), state: "ended" });
  return members.map((member) => {
    const used = numberOrZero(member.attacks);
    const possible = getRaidAttackLimit(member) || 6;
    return {
      tag: member.tag,
      name: member.name || member.tag || "unknown",
      used,
      possible,
      left: Math.max(possible - used, 0),
    };
  }).filter((member) => member.left > 0).sort((a, b) => {
    if (a.used === 0 && b.used !== 0) return -1;
    if (b.used === 0 && a.used !== 0) return 1;
    if (a.left !== b.left) return b.left - a.left;
    return a.name.localeCompare(b.name);
  });
}

function renderRaidTodoBlock(season, rosterMembers = [], limit = 40, links = new Map()) {
  const todo = collectRaidTodoMembers(season, rosterMembers);
  if (!todo.length) return "✅ <b>Все рейд-атаки закрыты.</b>";

  const zero = todo.filter((item) => item.used === 0);
  const partial = todo.filter((item) => item.used > 0);
  const lines = ["🛖 <b>У кого остались рейды:</b>"];

  for (const item of [...zero, ...partial].slice(0, limit)) {
    lines.push(`• ${renderLinkedPlayerName(item, links)} — <b>${item.used}/${item.possible}</b>, осталось <b>${item.left}</b>`);
  }

  if (todo.length > limit) lines.push(`…и ещё ${todo.length - limit}`);
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* War efficiency                                                              */
/* -------------------------------------------------------------------------- */

function renderWarEfficiency(wars, requestedCount, env) {
  const actualCount = wars.length;
  const clanStats = calculateClanWarStats(wars);
  const playerStats = calculatePlayerWarStats(wars);

  const lines = [
    `🏆 <b>Результативность за последние ${actualCount} КВ</b>`,
    "",
    "📊 <b>Итог клана</b>",
    `Победы/ничьи/поражения: <b>${clanStats.wins}/${clanStats.ties}/${clanStats.losses}</b>`,
    `Винрейт: <b>${formatPercent(clanStats.winRate)}</b>`,
    `Средние звёзды: <b>${clanStats.avgStars.toFixed(2)}</b> — <b>${clanStats.avgOpponentStars.toFixed(2)}</b>`,
    clanStats.hasReliableDestruction
      ? `Среднее разрушение: <b>${formatPercent(clanStats.avgDestruction)}</b> — <b>${formatPercent(clanStats.avgOpponentDestruction)}</b>`
      : "Среднее разрушение: <b>нет надёжных данных в warlog</b>",
    clanStats.hasReliableAttackUsage
      ? `Использование атак: <b>${formatPercent(clanStats.attackUsageRate)}</b>`
      : "Использование атак: <b>нет надёжных данных в warlog</b>",
    clanStats.hasReliablePerfectWars
      ? `Идеальные войны: <b>${clanStats.perfectWars}</b>`
      : "Идеальные войны: <b>нет надёжных данных</b>",
    "",
  ];

  if (!playerStats.length) {
    lines.push("По игрокам статистика не найдена в warlog — официальный API часто отдаёт историю КВ без детализации по участникам.");
    lines.push("Детальную статистику по игрокам бот сможет копить сам по тем войнам, которые он видел через cron.");
    lines.push("", "Последние войны:");
    for (const war of wars.slice(0, 10)) lines.push(renderWarLogLine(war, env));
    return lines.join("\n");
  }

  lines.push("🔥 <b>Топ по атакам</b>");
  for (const [index, player] of playerStats.slice(0, 15).entries()) {
    lines.push(`${index + 1}. <b>${escapeHtml(player.name)}</b> — ${player.avgStars.toFixed(2)}⭐ — ${formatPercent(player.avgDestruction)} — атаки <b>${player.attacksUsed}/${player.possibleAttacks}</b> — 3⭐ <b>${player.triples}</b>`);
  }

  const missed = playerStats.filter((player) => player.missedAttacks > 0).sort((a, b) => b.missedAttacks - a.missedAttacks || a.name.localeCompare(b.name));

  if (missed.length) {
    lines.push("", "⚠️ <b>Пропуски атак</b>");
    for (const player of missed.slice(0, 12)) lines.push(`• ${escapeHtml(player.name)} — пропущено <b>${player.missedAttacks}</b>, использовано <b>${player.attacksUsed}/${player.possibleAttacks}</b>`);
  }

  lines.push("", "Последние войны:");
  for (const war of wars.slice(0, 10)) lines.push(renderWarLogLine(war, env));
  if (requestedCount > actualCount) lines.push("", `Нашёл только ${actualCount} войн из запрошенных ${requestedCount}.`);
  return lines.join("\n");
}

function calculateClanWarStats(wars) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let stars = 0;
  let opponentStars = 0;
  let destruction = 0;
  let opponentDestruction = 0;
  let destructionCount = 0;
  let attacksUsed = 0;
  let possibleAttacks = 0;
  let perfectWars = 0;
  let reliablePerfectWarsCount = 0;

  for (const war of wars) {
    const result = normalizeWarResult(war.result);
    if (result === "win") wins++;
    else if (result === "lose") losses++;
    else ties++;

    const clan = war.clan || {};
    const opponent = war.opponent || {};
    const clanStars = numberOrZero(clan.stars);
    const opponentClanStars = numberOrZero(opponent.stars);
    const teamSize = inferWarTeamSize(war);
    const attacksPerMember = numberOrZero(war.attacksPerMember) || 2;
    const maxStars = teamSize ? teamSize * 3 : 0;
    const maxAttacks = teamSize ? teamSize * attacksPerMember : 0;
    const clanAttacks = numberOrZero(clan.attacks);

    stars += clanStars;
    opponentStars += opponentClanStars;
    attacksUsed += clanAttacks;
    possibleAttacks += maxAttacks;

    const clanDestruction = getReliableDestructionPercentage(clan);
    const enemyDestruction = getReliableDestructionPercentage(opponent);

    if (clanDestruction !== null && enemyDestruction !== null) {
      destruction += clanDestruction;
      opponentDestruction += enemyDestruction;
      destructionCount++;
    }

    if (maxStars && clanStars <= maxStars && opponentClanStars <= maxStars) {
      reliablePerfectWarsCount++;
      if (clanStars === maxStars) perfectWars++;
    }
  }

  const total = Math.max(wars.length, 1);
  const hasReliableAttackUsage = possibleAttacks > 0 && attacksUsed <= possibleAttacks;
  const hasReliableDestruction = destructionCount > 0;

  return {
    wins,
    losses,
    ties,
    winRate: wins / total * 100,
    avgStars: stars / total,
    avgOpponentStars: opponentStars / total,
    avgDestruction: hasReliableDestruction ? destruction / destructionCount : 0,
    avgOpponentDestruction: hasReliableDestruction ? opponentDestruction / destructionCount : 0,
    hasReliableDestruction,
    attackUsageRate: hasReliableAttackUsage ? attacksUsed / possibleAttacks * 100 : 0,
    hasReliableAttackUsage,
    perfectWars,
    hasReliablePerfectWars: reliablePerfectWarsCount > 0,
  };
}

function calculatePlayerWarStats(wars) {
  const byTag = new Map();

  for (const war of wars) {
    const members = (war.clan && war.clan.members) || [];
    const attacksPerMember = numberOrZero(war.attacksPerMember) || 2;

    for (const member of members) {
      const tag = member.tag || member.name || "unknown";
      const attacks = member.attacks || [];

      if (!byTag.has(tag)) {
        byTag.set(tag, { tag, name: member.name || tag, warsInLineup: 0, possibleAttacks: 0, attacksUsed: 0, missedAttacks: 0, totalStars: 0, totalDestruction: 0, triples: 0 });
      }

      const stat = byTag.get(tag);
      stat.name = member.name || stat.name;
      stat.warsInLineup++;
      stat.possibleAttacks += attacksPerMember;
      stat.attacksUsed += attacks.length;
      stat.missedAttacks += Math.max(attacksPerMember - attacks.length, 0);

      for (const attack of attacks) {
        const attackStars = numberOrZero(attack.stars);
        stat.totalStars += attackStars;
        stat.totalDestruction += numberOrZero(attack.destructionPercentage);
        if (attackStars >= 3) stat.triples++;
      }
    }
  }

  return [...byTag.values()].map((stat) => ({
    ...stat,
    avgStars: stat.attacksUsed ? stat.totalStars / stat.attacksUsed : 0,
    avgDestruction: stat.attacksUsed ? stat.totalDestruction / stat.attacksUsed : 0,
    usageRate: stat.possibleAttacks ? stat.attacksUsed / stat.possibleAttacks * 100 : 0,
  })).sort((a, b) => b.avgStars - a.avgStars || b.avgDestruction - a.avgDestruction || b.attacksUsed - a.attacksUsed || a.name.localeCompare(b.name));
}

function renderWarLogLine(war, env) {
  const clan = war.clan || {};
  const opponent = war.opponent || {};
  const result = normalizeWarResult(war.result);
  const icon = result === "win" ? "✅" : result === "lose" ? "❌" : "➖";
  const date = war.endTime ? formatCocTime(war.endTime, env) : "-";
  const clanDestruction = getReliableDestructionPercentage(clan);
  const opponentDestruction = getReliableDestructionPercentage(opponent);
  const destructionText = clanDestruction !== null && opponentDestruction !== null
    ? ` ${formatPercent(clanDestruction)} vs ${formatPercent(opponentDestruction)}`
    : "";

  return `${icon} ${escapeHtml(date)} <b>${numberOrZero(clan.stars)}⭐</b> vs <b>${numberOrZero(opponent.stars)}⭐</b>${destructionText} ${escapeHtml(opponent.name || "противник")}`;
}

function normalizeWarResult(result) {
  const value = String(result || "").trim().toLowerCase();
  if (value === "win" || value === "won") return "win";
  if (value === "lose" || value === "loss" || value === "lost") return "lose";
  return "tie";
}

function inferWarTeamSize(war) {
  const clan = war.clan || {};
  const opponent = war.opponent || {};
  const attacksPerMember = numberOrZero(war.attacksPerMember) || 2;
  const candidates = [
    numberOrZero(war.teamSize),
    Math.ceil(numberOrZero(clan.stars) / 3),
    Math.ceil(numberOrZero(opponent.stars) / 3),
    Math.ceil(numberOrZero(clan.attacks) / attacksPerMember),
    Math.ceil(numberOrZero(opponent.attacks) / attacksPerMember),
    Array.isArray(clan.members) ? clan.members.length : 0,
    Array.isArray(opponent.members) ? opponent.members.length : 0,
  ].filter((value) => Number.isFinite(value) && value > 0);

  return candidates.length ? Math.max(...candidates) : 0;
}

function getReliableDestructionPercentage(clanLike) {
  const raw = clanLike && clanLike.destructionPercentage;
  const value = Number(raw);

  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 100) return value;

  return null;
}

function isCocNotFoundError(error) {
  const text = String((error && error.message) || error || "").toLowerCase();
  return text.includes("404") || text.includes("notfound");
}

/* -------------------------------------------------------------------------- */
/* War calculations                                                            */
/* -------------------------------------------------------------------------- */

function countUsedAttacks(members) {
  return (members || []).reduce((sum, member) => sum + ((member.attacks || []).length), 0);
}

function getOurAttacksLeft(war) {
  const teamSize = numberOrZero(war.teamSize);
  const attacksPerMember = numberOrZero(war.attacksPerMember);
  const maxAttacks = teamSize * attacksPerMember;
  const used = countUsedAttacks((war.clan && war.clan.members) || []);
  return Math.max(maxAttacks - used, 0);
}

function getNotFullyAttackedMembers(members, attacksPerMember) {
  const max = Number(attacksPerMember || 0);
  if (!max) return [];

  return (members || []).map((member) => {
    const used = (member.attacks || []).length;
    return { tag: member.tag, name: member.name || member.tag || "unknown", used, left: Math.max(max - used, 0), mapPosition: member.mapPosition || 999 };
  }).filter((member) => member.left > 0).sort((a, b) => a.mapPosition - b.mapPosition || a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------- */
/* Chat state                                                                  */
/* -------------------------------------------------------------------------- */

async function maybeHandlePendingInput(env, chatId, text, replyExtra = {}) {
  if (!env.DB) return false;
  const value = String(text || "").trim();
  if (!/^\d{1,2}$/.test(value)) return false;

  await ensureRuntimeTables(env.DB);
  const state = await getChatState(env.DB, chatId);
  if (!state) return false;

  if (new Date(state.expires_at).getTime() < Date.now()) {
    await clearChatState(env.DB, chatId);
    return false;
  }

  if (state.type !== "awaiting_eff_count") return false;

  await clearChatState(env.DB, chatId);
  await sendWarEfficiency(env, chatId, parseRequestedCount(value, 10, 50));
  return true;
}

async function getChatState(db, chatId) {
  return db.prepare("SELECT * FROM bot_states WHERE chat_id = ?").bind(String(chatId)).first();
}

async function setChatState(db, chatId, type, payload = {}, ttlSeconds = 120) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await db.prepare(`
    INSERT INTO bot_states (chat_id, type, payload, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      type = excluded.type,
      payload = excluded.payload,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).bind(String(chatId), type, JSON.stringify(payload || {}), now.toISOString(), expiresAt.toISOString()).run();
}

async function clearChatState(db, chatId) {
  await db.prepare("DELETE FROM bot_states WHERE chat_id = ?").bind(String(chatId)).run();
}

/* -------------------------------------------------------------------------- */
/* Coin                                                                        */
/* -------------------------------------------------------------------------- */

function isCoinText(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized === "монетка" || normalized === "кинь монетку" || normalized === "подбрось монетку" || normalized === "coin" || normalized === "flip";
}

async function sendCoinFlip(env, chatId, replyExtra = {}) {
  const isHeads = Math.random() < 0.5;
  const result = isHeads ? "Ореховский (орёл)" : "Hiper (решка)";
  const emoji = isHeads ? "🦅" : "🪙";
  const variants = [`${emoji} <b>${result}</b>`, `🪙 Монетка решила: <b>${result}</b>`, `🎲 Выпало: <b>${result}</b>`];
  await tgSendMessage(env, chatId, variants[Math.floor(Math.random() * variants.length)], withExtra(replyExtra, { parse_mode: "HTML" }));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatWarState(state) {
  const map = { preparation: "подготовка", inWar: "идёт война", warEnded: "война закончилась", notInWar: "не в войне" };
  return map[state] || state || "неизвестно";
}

function formatCocTime(value, env) {
  const date = parseCocTime(value);
  if (!date) return String(value || "-");
  const timeZone = env.TIMEZONE || DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat("ru-RU", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatIsoDateTime(value, env = {}) {
  const date = new Date(value || "");
  if (!Number.isFinite(date.getTime())) return String(value || "-");
  const timeZone = env.TIMEZONE || DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat("ru-RU", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function parseCocTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

function formatPercent(value) {
  const number = Number(value || 0);
  return `${number.toFixed(2)}%`;
}

function renderStars(stars) {
  const value = Math.max(0, Math.min(3, Number(stars || 0)));
  return "⭐".repeat(value) + "☆".repeat(3 - value);
}

function formatMinutesHuman(minutes) {
  const value = Math.max(0, Number(minutes || 0));
  if (value >= 60) {
    const hours = Math.floor(value / 60);
    const rest = value % 60;
    if (!rest) return `${hours} ч`;
    return `${hours} ч ${rest} мин`;
  }
  return `${value} мин`;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getNumberEnv(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseRequestedCount(value, fallback = 10, max = 50) {
  const match = String(value || "").trim().match(/^(\d{1,2})$/);
  if (!match) return fallback;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count <= 0) return fallback;
  return Math.max(1, Math.min(count, max));
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeJsonParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}
