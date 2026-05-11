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
 * Required bindings:
 * - DB D1 database, binding name must be DB
 */

const DEFAULT_COC_API_BASE = "https://cocproxy.royaleapi.dev/v1";
const DEFAULT_TIMEZONE = "Europe/Riga";
const MAX_TG_MESSAGE_LENGTH = 3900;

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

async function handleTelegramUpdate(update, env) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const chatType = msg.chat.type || "private";
  const text = String(msg.text || "").trim();

  if (!text) return;

  const isGroupChat = chatType === "group" || chatType === "supergroup";
  const command = parseTelegramCommand(text, env);

  if (!command) {
    if (isCoinText(text)) {
      await sendCoinFlip(env, chatId);
      return;
    }

    const handledPendingInput = await maybeHandlePendingInput(env, chatId, text);
    if (handledPendingInput) return;
  }

  if (isGroupChat && !command) return;

  if (isGroupChat && command && command.mentionedBot && !command.isForThisBot) return;

  if (!command) {
    await tgSendMessage(env, chatId, "Не понял команду. Напиши /help.");
    return;
  }

  if (command.name === "start" || command.name === "help" || command.name === "menu") {
    await sendHelp(env, chatId);
    return;
  }

  if (command.name === "stats") {
    await handleStatsCommand(env, chatId, command.args);
    return;
  }

  if (command.name === "war" || command.name === "status") {
    await sendWarStatus(env, chatId);
    return;
  }

  if (command.name === "todo") {
    await sendWarTodo(env, chatId);
    return;
  }

  if (command.name === "eff" || command.name === "result") {
    await handleWarEfficiencyCommand(env, chatId, command.args);
    return;
  }

  if (command.name === "cwl" || command.name === "lvk" || command.name === "лвк") {
    await sendCwlStatus(env, chatId);
    return;
  }

  if (command.name === "raid" || command.name === "raids" || command.name === "рейд" || command.name === "рейды") {
    await sendRaidStats(env, chatId, parseRequestedCount(command.args, 5, 20));
    return;
  }

  if (command.name === "events" || command.name === "event" || command.name === "ивенты") {
    await sendEventsInfo(env, chatId);
    return;
  }

  if (command.name === "coin" || command.name === "flip" || command.name === "monetka") {
    await sendCoinFlip(env, chatId);
    return;
  }

  if (command.name === "ping") {
    await tgSendMessage(env, chatId, "pong");
    return;
  }

  if (command.name === "chatid") {
    await tgSendMessage(
      env,
      chatId,
      [
        "ID этого чата:",
        `<code>${escapeHtml(String(chatId))}</code>`,
        "",
        "Если это группа клана — этот ID поставь в WAR_CHAT_ID.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return;
  }

  if (command.name === "check") {
    await sendManualCheck(env, chatId);
    return;
  }

  if (command.name === "attacks") {
    await sendWarAttacks(env, chatId);
    return;
  }

  if (isGroupChat) return;

  await tgSendMessage(env, chatId, "Не понял команду. Напиши /help.");
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

async function sendHelp(env, chatId) {
  const text = [
    "⚔️ <b>Клешка ботик</b>",
    "",
    "<b>Главное</b>",
    "⚔️ /war — текущая КВ",
    "🕒 /todo — кто не атаковал",
    "🏰 /cwl — ЛВК сейчас",
    "🛖 /raid — рейды столицы",
    "",
    "<b>Статистика</b>",
    "📊 /stats — меню статистики",
    "🏆 /stats war 10 — результативность КВ",
    "🏰 /stats cwl — сводка ЛВК",
    "🛖 /stats raid 5 — последние рейды",
    "",
    "<b>Прочее</b>",
    "🪙 /coin — монетка 50/50",
    "🎉 /events — что бот умеет отслеживать",
    "",
    "Авто: КВ, ЛВК, новые атаки, рейды, напоминания без дублей.",
  ].join("\n");

  await tgSendMessage(env, chatId, text, { parse_mode: "HTML" });
}

async function handleStatsCommand(env, chatId, args) {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  const section = (parts[0] || "").toLowerCase();
  const count = parseRequestedCount(parts[1], 10, 50);

  if (!section) {
    await sendStatsHelp(env, chatId);
    return;
  }

  if (["war", "wars", "kv", "кв"].includes(section)) {
    await sendWarEfficiency(env, chatId, count);
    return;
  }

  if (["cwl", "lvk", "лвк", "league"].includes(section)) {
    await sendCwlStatus(env, chatId);
    return;
  }

  if (["raid", "raids", "рейд", "рейды", "capital"].includes(section)) {
    await sendRaidStats(env, chatId, parseRequestedCount(parts[1], 5, 20));
    return;
  }

  await sendStatsHelp(env, chatId);
}

async function sendStatsHelp(env, chatId) {
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
    { parse_mode: "HTML" }
  );
}

async function handleWarEfficiencyCommand(env, chatId, args) {
  const count = parseRequestedCount(args, 0, 50);

  if (count) {
    await sendWarEfficiency(env, chatId, count);
    return;
  }

  if (!env.DB) {
    await tgSendMessage(env, chatId, "Не могу ждать ввод числа: не подключена D1-база.");
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
    { parse_mode: "HTML" }
  );
}

async function sendManualCheck(env, chatId) {
  try {
    const results = await runAllWatchers(env, { notify: true, chatId, manual: true });

    await tgSendMessage(
      env,
      chatId,
      [
        "✅ Проверка выполнена.",
        "",
        `КВ: ${results.war && results.war.state ? results.war.state : "-"}`,
        `ЛВК: ${results.cwl && results.cwl.state ? results.cwl.state : "-"}`,
        `Рейды: ${results.raid && results.raid.state ? results.raid.state : "-"}`,
      ].join("\n")
    );
  } catch (e) {
    console.error("manual check error:", e);
    await tgSendMessage(env, chatId, `Не смог выполнить проверку: ${e.message || e}`);
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

async function sendWarStatus(env, chatId) {
  try {
    const war = await getCurrentWar(env);
    await tgSendLongMessage(env, chatId, renderWarStatus(war, env), { parse_mode: "HTML" });
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
      { parse_mode: "HTML" }
    );
  }
}

async function sendWarTodo(env, chatId) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в КВ.");
      return;
    }

    await tgSendLongMessage(env, chatId, renderTodoBlock(war, 80), { parse_mode: "HTML" });
  } catch (e) {
    console.error("sendWarTodo error:", e);
    await tgSendMessage(env, chatId, `Не смог получить список атак: ${e.message || e}`);
  }
}

async function sendWarAttacks(env, chatId) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в КВ.");
      return;
    }

    const attacks = collectWarAttacks(war);

    if (!attacks.length) {
      await tgSendMessage(env, chatId, "В этой КВ пока нет атак.");
      return;
    }

    const lines = ["⚔️ <b>Атаки текущей КВ</b>", ""];
    for (const attack of attacks.slice(-60)) lines.push(renderAttackLine(attack));
    if (attacks.length > 60) lines.push("", `Показаны последние 60 атак из ${attacks.length}.`);

    await tgSendLongMessage(env, chatId, lines.join("\n"), { parse_mode: "HTML" });
  } catch (e) {
    console.error("sendWarAttacks error:", e);
    await tgSendMessage(env, chatId, `Не смог получить атаки: ${e.message || e}`);
  }
}

async function sendWarEfficiency(env, chatId, requestedCount) {
  try {
    const count = Math.max(1, Math.min(Number(requestedCount || 10), 50));
    const wars = await getWarLog(env, count);

    if (!wars.length) {
      await tgSendMessage(env, chatId, "Не нашёл историю КВ. Возможно, журнал войн закрыт или войн ещё нет.");
      return;
    }

    await tgSendLongMessage(env, chatId, renderWarEfficiency(wars, count, env), { parse_mode: "HTML" });
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
      { parse_mode: "HTML" }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* CWL                                                                         */
/* -------------------------------------------------------------------------- */

async function sendCwlStatus(env, chatId) {
  try {
    const group = await getCurrentCwlGroup(env);

    if (!group || group.state === "notInWar") {
      await tgSendMessage(env, chatId, "🏰 Сейчас активной ЛВК не найдено.");
      return;
    }

    const cwlWar = await getRelevantCwlWar(env, group).catch((e) => {
      console.error("getRelevantCwlWar error:", e);
      return null;
    });

    await tgSendLongMessage(env, chatId, renderCwlStatus(group, cwlWar, env), { parse_mode: "HTML" });
  } catch (e) {
    console.error("sendCwlStatus error:", e);
    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог получить ЛВК.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
        "",
        "Если ЛВК сейчас не идёт, это нормально.",
      ].join("\n"),
      { parse_mode: "HTML" }
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

async function sendRaidStats(env, chatId, requestedCount = 5) {
  try {
    const count = Math.max(1, Math.min(Number(requestedCount || 5), 20));
    const seasons = await getCapitalRaidSeasons(env, count);

    if (!seasons.length) {
      await tgSendMessage(env, chatId, "🛖 Рейды столицы не найдены.");
      return;
    }

    await tgSendLongMessage(env, chatId, renderRaidStats(seasons, env), { parse_mode: "HTML" });
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
      { parse_mode: "HTML" }
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
/* Events info                                                                 */
/* -------------------------------------------------------------------------- */

async function sendEventsInfo(env, chatId) {
  await tgSendMessage(
    env,
    chatId,
    [
      "🎉 <b>События</b>",
      "",
      "Официальный API нормально отдаёт:",
      "⚔️ КВ и атаки",
      "🏰 ЛВК",
      "🛖 Рейды столицы",
      "",
      "Календарь игровых ивентов/испытаний API сейчас не отдаёт, поэтому бот их не трекает автоматически.",
      "Можно позже добавить ручные напоминания или отдельный парсер новостей, но это уже отдельный модуль.",
    ].join("\n"),
    { parse_mode: "HTML" }
  );
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
  const chatId = options.chatId || env.WAR_CHAT_ID || "";

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
  });
}

async function processWarLikeObject(env, chatId, war, config = {}) {
  const warId = getWarId(war, config.type || "war");
  const previous = await getWarRecord(env.DB, warId);
  const firstSeen = !previous;
  const previousState = previous && previous.state ? previous.state : "";
  const notify = config.notify !== false;
  const attacks = collectWarAttacks(war, config.type || "war");
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

    if (notify && chatId) {
      await tgSendLongMessage(env, chatId, renderWarAnnouncement(war, env, config.titleNew), { parse_mode: "HTML" });
    }

    return { ok: true, state: war.state, warId, firstSeen: true, insertedAttacks, notifiedAttacks };
  }

  await upsertWarRecord(env.DB, warId, war);

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
    await tgSendLongMessage(env, chatId, renderAttackBatchMessage(war, newAttacks, env, config.type || "war"), { parse_mode: "HTML" });
    notifiedAttacks = newAttacks.length;
  }

  if (notify && chatId && config.timers !== false) {
    timerNotified = await maybeSendWarTimers(env, chatId, war, { skipPeriodicTodo: stateNotified || notifiedAttacks > 0, prefix: config.type || "war" });
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
  if (war.state === "inWar") {
    await tgSendLongMessage(
      env,
      chatId,
      [config.titleStarted || "⚔️ <b>Война началась!</b>", "", renderScoreLine(war), "", renderAttacksLeftLine(war), "", renderTodoBlock(war, 40)].join("\n"),
      { parse_mode: "HTML" }
    );
    return true;
  }

  if (war.state === "warEnded") {
    await tgSendLongMessage(
      env,
      chatId,
      [config.titleEnded || "🏁 <b>Война закончилась!</b>", "", renderWarSummaryText(war, env)].join("\n"),
      { parse_mode: "HTML" }
    );
    return true;
  }

  if (war.state === "preparation") {
    await tgSendLongMessage(env, chatId, renderWarAnnouncement(war, env, config.titleNew), { parse_mode: "HTML" });
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
  const chatId = options.chatId || env.WAR_CHAT_ID || "";

  if (!env.DB) throw new Error("D1 binding DB is missing");
  await ensureRuntimeTables(env.DB);

  const group = await getCurrentCwlGroup(env);

  if (!group || group.state === "notInWar") return { ok: true, state: "notInWar" };

  const eventId = `cwl:${group.season || "unknown"}:${(group.clans || []).map((clan) => clan.tag).join(",")}`;
  const previous = await getEventRecord(env.DB, eventId);
  const firstSeen = !previous;

  await upsertEventRecord(env.DB, eventId, "cwl", group.state || "", group);

  if (firstSeen && notify && chatId) {
    await tgSendLongMessage(env, chatId, renderCwlFound(group), { parse_mode: "HTML" });
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
  const chatId = options.chatId || env.WAR_CHAT_ID || "";

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

  await upsertEventRecord(env.DB, eventId, "raid", season.state || "", season);

  if (firstSeen && notify && chatId && season.state === "ongoing") {
    await tgSendLongMessage(env, chatId, ["🛖 <b>Рейд-уикенд начался</b>", "", renderRaidSeasonSummary(season, env, true)].join("\n"), { parse_mode: "HTML" });
    await markReminderSent(env.DB, eventId, "raid_started");
    return { ok: true, state: season.state, firstSeen: true };
  }

  if (notify && chatId && previousState && previousState !== season.state) {
    if (season.state === "ended") {
      await tgSendLongMessage(env, chatId, ["🏁 <b>Рейд-уикенд закончился</b>", "", renderRaidSeasonSummary(season, env, true)].join("\n"), { parse_mode: "HTML" });
      await markReminderSent(env.DB, eventId, "raid_ended");
      return { ok: true, state: season.state, changed: true };
    }
  }

  if (notify && chatId && season.state === "ongoing") {
    const changedEnough = isRaidProgressChangedEnough(previousRaw, season);
    const sent = await maybeSendRaidPeriodicReminder(env, chatId, eventId, season, changedEnough);
    return { ok: true, state: season.state, firstSeen, reminder: sent };
  }

  return { ok: true, state: season.state, firstSeen };
}

function getRaidEventId(season) {
  return `raid:${season.startTime || "unknownStart"}:${season.endTime || "unknownEnd"}`;
}

function isRaidProgressChangedEnough(previous, current) {
  if (!previous) return false;
  const prevAttacks = numberOrZero(previous.totalAttacks);
  const nextAttacks = numberOrZero(current.totalAttacks);
  const prevLoot = numberOrZero(previous.capitalTotalLoot);
  const nextLoot = numberOrZero(current.capitalTotalLoot);
  return nextAttacks - prevAttacks >= 10 || nextLoot - prevLoot >= 5000;
}

async function maybeSendRaidPeriodicReminder(env, chatId, eventId, season, changedEnough) {
  const endTime = parseCocTime(season.endTime);
  const remainingMinutes = endTime ? Math.ceil((endTime.getTime() - Date.now()) / 60000) : 999999;

  if (remainingMinutes <= 0) return false;

  const intervalMinutes = remainingMinutes <= 360 ? 120 : 360;
  const bucket = Math.floor(Date.now() / (intervalMinutes * 60000));
  const kind = changedEnough ? `raid_progress_${bucket}` : `raid_periodic_${bucket}`;

  if (await isReminderSent(env.DB, eventId, kind)) return false;

  await tgSendLongMessage(env, chatId, ["🛖 <b>Контроль рейдов столицы</b>", "", renderRaidSeasonSummary(season, env, true)].join("\n"), { parse_mode: "HTML" });
  await markReminderSent(env.DB, eventId, kind);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Timers                                                                      */
/* -------------------------------------------------------------------------- */

async function maybeSendWarTimers(env, chatId, war, options = {}) {
  if (!war || !war.state) return false;

  const prefix = options.prefix || "war";
  let sentImportantTimer = false;

  if (war.state === "preparation") {
    sentImportantTimer = await maybeSendTimeReminder(env, chatId, war, {
      type: `${prefix}_start`,
      target: parseCocTime(war.startTime),
      thresholds: [360, 180, 60, 15],
    });
    return sentImportantTimer;
  }

  if (war.state === "inWar") {
    sentImportantTimer = await maybeSendTimeReminder(env, chatId, war, {
      type: `${prefix}_end`,
      target: parseCocTime(war.endTime),
      thresholds: [720, 360, 180, 60, 30, 10],
    });

    if (sentImportantTimer) return true;
    if (options.skipPeriodicTodo) return false;
    if (prefix !== "war") return false;

    return maybeSendPeriodicTodoReminder(env, chatId, war);
  }

  return false;
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

      await tgSendLongMessage(env, chatId, text, { parse_mode: "HTML" });
      await markReminderSent(env.DB, warId, kind);
      return true;
    }
  }

  return false;
}

async function maybeSendPeriodicTodoReminder(env, chatId, war) {
  if (String(env.PERIODIC_TODO_ENABLED || "true").toLowerCase() === "false") return false;

  const attacksLeft = getOurAttacksLeft(war);
  if (attacksLeft <= 0) return false;

  const endTime = parseCocTime(war.endTime);
  const remainingMinutes = endTime ? Math.ceil((endTime.getTime() - Date.now()) / 60000) : 999999;
  if (remainingMinutes <= 0) return false;

  const lateWindowMinutes = getNumberEnv(env, "TODO_REMINDER_LATE_WINDOW_MINUTES", 360);
  const earlyIntervalMinutes = getNumberEnv(env, "TODO_REMINDER_EARLY_MINUTES", 180);
  const lateIntervalMinutes = getNumberEnv(env, "TODO_REMINDER_LATE_MINUTES", 60);
  const intervalMinutes = remainingMinutes <= lateWindowMinutes ? lateIntervalMinutes : earlyIntervalMinutes;
  const bucket = Math.floor(Date.now() / (intervalMinutes * 60000));
  const kind = `todo_${intervalMinutes}_${bucket}`;
  const warId = getWarId(war, "war");

  if (await isReminderSent(env.DB, warId, kind)) return false;

  await tgSendLongMessage(env, chatId, renderPeriodicTodoReminder(war, remainingMinutes, env), { parse_mode: "HTML" });
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
  const notAttacked = getNotFullyAttackedMembers(ourMembers, attacksPerMember);

  if (!notAttacked.length) return "✅ <b>Все наши атаки использованы.</b>";

  const lines = ["🕒 <b>У кого остались атаки:</b>"];
  for (const item of notAttacked.slice(0, limit)) lines.push(`• #${item.mapPosition} ${escapeHtml(item.name)} — осталось <b>${item.left}</b>`);
  if (notAttacked.length > limit) lines.push(`…и ещё ${notAttacked.length - limit}`);
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
    `Среднее разрушение: <b>${formatPercent(clanStats.avgDestruction)}</b> — <b>${formatPercent(clanStats.avgOpponentDestruction)}</b>`,
    `Использование атак: <b>${formatPercent(clanStats.attackUsageRate)}</b>`,
    `Идеальные войны: <b>${clanStats.perfectWars}</b>`,
    "",
  ];

  if (!playerStats.length) {
    lines.push("По игрокам статистика не найдена в warlog.");
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
  let wins = 0, losses = 0, ties = 0, stars = 0, opponentStars = 0, destruction = 0, opponentDestruction = 0, attacksUsed = 0, possibleAttacks = 0, perfectWars = 0;

  for (const war of wars) {
    const result = normalizeWarResult(war.result);
    if (result === "win") wins++;
    else if (result === "lose") losses++;
    else ties++;

    const teamSize = numberOrZero(war.teamSize);
    const attacksPerMember = numberOrZero(war.attacksPerMember) || 2;
    const maxStars = teamSize * 3;
    const maxAttacks = teamSize * attacksPerMember;
    const clan = war.clan || {};
    const opponent = war.opponent || {};
    const clanStars = numberOrZero(clan.stars);

    stars += clanStars;
    opponentStars += numberOrZero(opponent.stars);
    destruction += getDestructionPercentage(clan);
    opponentDestruction += getDestructionPercentage(opponent);
    attacksUsed += numberOrZero(clan.attacks);
    possibleAttacks += maxAttacks;
    if (maxStars && clanStars >= maxStars) perfectWars++;
  }

  const total = Math.max(wars.length, 1);
  return {
    wins, losses, ties,
    winRate: wins / total * 100,
    avgStars: stars / total,
    avgOpponentStars: opponentStars / total,
    avgDestruction: destruction / total,
    avgOpponentDestruction: opponentDestruction / total,
    attackUsageRate: possibleAttacks ? attacksUsed / possibleAttacks * 100 : 0,
    perfectWars,
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
  return `${icon} ${escapeHtml(date)} <b>${numberOrZero(clan.stars)}⭐ ${formatPercent(getDestructionPercentage(clan))}</b> vs <b>${numberOrZero(opponent.stars)}⭐ ${formatPercent(getDestructionPercentage(opponent))}</b> ${escapeHtml(opponent.name || "противник")}`;
}

function normalizeWarResult(result) {
  const value = String(result || "").trim().toLowerCase();
  if (value === "win" || value === "won") return "win";
  if (value === "lose" || value === "loss" || value === "lost") return "lose";
  return "tie";
}

function getDestructionPercentage(clanLike) {
  const value = clanLike && clanLike.destructionPercentage;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value) || 0;
  return 0;
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

async function maybeHandlePendingInput(env, chatId, text) {
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

async function sendCoinFlip(env, chatId) {
  const isHeads = Math.random() < 0.5;
  const result = isHeads ? "Ореховский (орёл)" : "Hiper (решка)";
  const emoji = isHeads ? "🦅" : "🪙";
  const variants = [`${emoji} <b>${result}</b>`, `🪙 Монетка решила: <b>${result}</b>`, `🎲 Выпало: <b>${result}</b>`];
  await tgSendMessage(env, chatId, variants[Math.floor(Math.random() * variants.length)], { parse_mode: "HTML" });
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