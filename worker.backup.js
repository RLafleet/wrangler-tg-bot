/**
 * Clash of Clans Telegram war bot for Cloudflare Workers.
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
 * - DB D1 database
 */

const DEFAULT_COC_API_BASE = "https://cocproxy.royaleapi.dev/v1";
const DEFAULT_TIMEZONE = "Europe/Riga";
const MAX_TG_MESSAGE_LENGTH = 3900;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "coc-war-tg-bot",
      });
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
    headers: {
      "Content-Type": "application/json",
    },
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
      if (chunk.trim()) {
        await tgSendMessage(env, chatId, chunk, extra);
      }
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }

  if (chunk.trim()) {
    await tgSendMessage(env, chatId, chunk, extra);
  }
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

  // Если бот ждёт число после /eff — разрешаем один обычный числовой ответ.
  // В остальном в группах молчим на обычные сообщения.
  if (!command) {
    if (isCoinText(text)) {
      await sendCoinFlip(env, chatId);
      return;
    }

    const handledPendingInput = await maybeHandlePendingInput(env, chatId, text);
    if (handledPendingInput) return;
  }

  if (isGroupChat && !command) return;

  if (isGroupChat && command && command.mentionedBot && !command.isForThisBot) {
    return;
  }

  if (!command) {
    await tgSendMessage(env, chatId, "Не понял команду. Напиши /help.");
    return;
  }

  if (command.name === "start" || command.name === "help") {
    await sendHelp(env, chatId);
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

  if (command.name === "start" || command.name === "help") {
    await sendHelp(env, chatId);
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

  if (command.name === "war" || command.name === "status" || command.name === "summary") {
    await sendWarStatus(env, chatId);
    return;
  }

  if (command.name === "todo") {
    await sendWarTodo(env, chatId);
    return;
  }

  if (command.name === "coin" || command.name === "flip" || command.name === "monetka") {
    await sendCoinFlip(env, chatId);
    return;
  }

  if (command.name === "eff" || command.name === "stats" || command.name === "result") {
    const count = parseRequestedWarCount(command.args);

    if (count) {
      await sendWarEfficiency(env, chatId, count);
      return;
    }

    if (!env.DB) {
      await tgSendMessage(env, chatId, "Не могу ждать ввод числа: не подключена D1-база.");
      return;
    }

    await setChatState(env.DB, chatId, "awaiting_eff_count", {}, 120);

    await tgSendMessage(
      env,
      chatId,
      [
        "🏆 За сколько последних войн посчитать результативность?",
        "",
        "Например, напиши:",
        "<code>10</code>",
        "",
        "Или сразу командой:",
        "<code>/eff 10</code>",
      ].join("\n"),
      { parse_mode: "HTML" }
    );

    return;
  }

  // Служебная команда, в help не показываем.
  if (command.name === "check") {
    try {
      const result = await runWarWatcher(env, {
        notify: true,
        chatId,
        manual: true,
      });

      await tgSendMessage(
        env,
        chatId,
        [
          "✅ Проверка войны выполнена.",
          "",
          `Состояние: ${result.state || "-"}`,
          `Новых атак: ${result.insertedAttacks || 0}`,
          `Уведомлений по атакам: ${result.notifiedAttacks || 0}`,
        ].join("\n")
      );
    } catch (e) {
      console.error("manual check error:", e);
      await tgSendMessage(
        env,
        chatId,
        `Не смог выполнить проверку: ${e.message || e}`
      );
    }

    return;
  }

  // Служебная команда, в help не показываем.
  if (command.name === "attacks") {
    await sendWarAttacks(env, chatId);
    return;
  }

  if (isGroupChat) return;

  await tgSendMessage(env, chatId, "Не понял команду. Напиши /help.");
}

async function getWarLog(env, limit = 10) {
  const clanTag = encodeTag(env.CLAN_TAG);
  const safeLimit = Math.max(1, Math.min(Number(limit || 10), 50));

  const data = await cocGet(env, `/clans/${clanTag}/warlog?limit=${safeLimit}`);

  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;

  return [];
}

function parseTelegramCommand(text, env) {
  const normalized = String(text || "").trim();
  const match = normalized.match(/^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s|$)/);

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
    "Основные команды:",
    "",
    "⚔️ /war — текущая война, счёт, атаки, время",
    "🕒 /todo — кто ещё не атаковал",
    "🏆 /eff 10 — результативность за последние 10 войн",
    "🪙 /coin — монетка 50/50",
    "",
    "Можно просто написать /eff, и я попрошу число войн.",
    "",
    "Автоматически бот пишет:",
    "• новую найденную войну",
    "• старт войны",
    "• новые атаки",
    "• напоминания перед концом",
    "• итог войны",
  ].join("\n");

  await tgSendMessage(env, chatId, text, {
    parse_mode: "HTML",
  });
}

/* -------------------------------------------------------------------------- */
/* Clash of Clans API                                                          */
/* -------------------------------------------------------------------------- */

function getCocApiBase(env) {
  return String(env.COC_API_BASE || DEFAULT_COC_API_BASE).replace(/\/+$/, "");
}

function encodeTag(tag) {
  const normalized = String(tag || "").trim().toUpperCase();

  if (!normalized) {
    throw new Error("CLAN_TAG is empty");
  }

  const withHash = normalized.startsWith("#") ? normalized : `#${normalized}`;
  return encodeURIComponent(withHash);
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
  const clanTag = encodeTag(env.CLAN_TAG);
  return cocGet(env, `/clans/${clanTag}/currentwar`);
}

/* -------------------------------------------------------------------------- */
/* Manual commands                                                             */
/* -------------------------------------------------------------------------- */

async function sendWarStatus(env, chatId) {
  try {
    const war = await getCurrentWar(env);
    const text = renderWarStatus(war, env);

    await tgSendLongMessage(env, chatId, text, {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("sendWarStatus error:", e);

    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог получить текущую войну.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
        "",
        "Если ключ точно рабочий, проверьте, открыт ли журнал войн клана.",
        "Для текущей войны API часто отдаёт 403, если War Log закрыт.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}

async function sendWarTodo(env, chatId) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в войне.");
      return;
    }

    await tgSendLongMessage(env, chatId, renderTodoBlock(war, 80), {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("sendWarTodo error:", e);
    await tgSendMessage(env, chatId, `Не смог получить список атак: ${e.message || e}`);
  }
}

async function sendWarAttacks(env, chatId) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в войне.");
      return;
    }

    const attacks = collectWarAttacks(war);

    if (!attacks.length) {
      await tgSendMessage(env, chatId, "В этой войне пока нет атак.");
      return;
    }

    const lines = [
      "⚔️ <b>Атаки текущей войны</b>",
      "",
    ];

    for (const attack of attacks.slice(-60)) {
      lines.push(renderAttackLine(attack));
    }

    if (attacks.length > 60) {
      lines.push("");
      lines.push(`Показаны последние 60 атак из ${attacks.length}.`);
    }

    await tgSendLongMessage(env, chatId, lines.join("\n"), {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("sendWarAttacks error:", e);
    await tgSendMessage(env, chatId, `Не смог получить атаки: ${e.message || e}`);
  }
}

async function sendWarSummary(env, chatId) {
  try {
    const war = await getCurrentWar(env);

    if (!war || war.state === "notInWar") {
      await tgSendMessage(env, chatId, "Клан сейчас не в войне.");
      return;
    }

    await tgSendLongMessage(env, chatId, renderWarSummaryText(war, env), {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("sendWarSummary error:", e);
    await tgSendMessage(env, chatId, `Не смог получить сводку: ${e.message || e}`);
  }
}

/* -------------------------------------------------------------------------- */
/* War efficiency                                                              */
/* -------------------------------------------------------------------------- */

async function sendWarEfficiency(env, chatId, requestedCount) {
  try {
    const count = Math.max(1, Math.min(Number(requestedCount || 10), 50));
    const wars = await getWarLog(env, count);

    if (!wars.length) {
      await tgSendMessage(
        env,
        chatId,
        "Не нашёл историю войн. Возможно, журнал войн закрыт или войн ещё нет."
      );
      return;
    }

    await tgSendLongMessage(env, chatId, renderWarEfficiency(wars, count, env), {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("sendWarEfficiency error:", e);

    await tgSendMessage(
      env,
      chatId,
      [
        "Не смог посчитать результативность.",
        "",
        `Ошибка: <code>${escapeHtml(e.message || String(e))}</code>`,
        "",
        "Если ошибка 403 — проверь, что журнал войн открыт.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}

function renderWarEfficiency(wars, requestedCount, env) {
  const actualCount = wars.length;
  const clanStats = calculateClanWarStats(wars);
  const playerStats = calculatePlayerWarStats(wars);

  const lines = [
    `🏆 <b>Результативность за последние ${actualCount} войн</b>`,
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
    lines.push(
      [
        `${index + 1}. <b>${escapeHtml(player.name)}</b>`,
        `${player.avgStars.toFixed(2)}⭐/атака`,
        `${formatPercent(player.avgDestruction)}`,
        `атаки <b>${player.attacksUsed}/${player.possibleAttacks}</b>`,
        `триплы <b>${player.triples}</b>`,
      ].join(" — ")
    );
  }

  const missed = playerStats
    .filter((player) => player.missedAttacks > 0)
    .sort((a, b) => {
      if (b.missedAttacks !== a.missedAttacks) return b.missedAttacks - a.missedAttacks;
      return a.name.localeCompare(b.name);
    });

  if (missed.length) {
    lines.push("");
    lines.push("⚠️ <b>Пропуски атак</b>");

    for (const player of missed.slice(0, 12)) {
      lines.push(
        `• ${escapeHtml(player.name)} — пропущено <b>${player.missedAttacks}</b>, использовано <b>${player.attacksUsed}/${player.possibleAttacks}</b>`
      );
    }
  }

  lines.push("");
  lines.push("Последние войны:");
  for (const war of wars.slice(0, 10)) {
    lines.push(renderWarLogLine(war, env));
  }

  if (requestedCount > actualCount) {
    lines.push("");
    lines.push(`Нашёл только ${actualCount} войн из запрошенных ${requestedCount}.`);
  }

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
  let attacksUsed = 0;
  let possibleAttacks = 0;
  let perfectWars = 0;

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
    const opponentClanStars = numberOrZero(opponent.stars);

    stars += clanStars;
    opponentStars += opponentClanStars;
    destruction += getDestructionPercentage(clan);
    opponentDestruction += getDestructionPercentage(opponent);
    attacksUsed += numberOrZero(clan.attacks);
    possibleAttacks += maxAttacks;

    if (maxStars && clanStars >= maxStars) {
      perfectWars++;
    }
  }

  const total = Math.max(wars.length, 1);

  return {
    total,
    wins,
    losses,
    ties,
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
        byTag.set(tag, {
          tag,
          name: member.name || tag,
          warsInLineup: 0,
          possibleAttacks: 0,
          attacksUsed: 0,
          missedAttacks: 0,
          totalStars: 0,
          totalDestruction: 0,
          triples: 0,
        });
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

        if (attackStars >= 3) {
          stat.triples++;
        }
      }
    }
  }

  return [...byTag.values()]
    .map((stat) => {
      const avgStars = stat.attacksUsed ? stat.totalStars / stat.attacksUsed : 0;
      const avgDestruction = stat.attacksUsed ? stat.totalDestruction / stat.attacksUsed : 0;
      const usageRate = stat.possibleAttacks ? stat.attacksUsed / stat.possibleAttacks * 100 : 0;

      return {
        ...stat,
        avgStars,
        avgDestruction,
        usageRate,
      };
    })
    .sort((a, b) => {
      if (b.avgStars !== a.avgStars) return b.avgStars - a.avgStars;
      if (b.avgDestruction !== a.avgDestruction) return b.avgDestruction - a.avgDestruction;
      if (b.attacksUsed !== a.attacksUsed) return b.attacksUsed - a.attacksUsed;
      return a.name.localeCompare(b.name);
    });
}

function renderWarLogLine(war, env) {
  const clan = war.clan || {};
  const opponent = war.opponent || {};
  const result = normalizeWarResult(war.result);
  const icon = result === "win" ? "✅" : result === "lose" ? "❌" : "➖";

  const date = war.endTime ? formatCocTime(war.endTime, env) : "-";

  return [
    `${icon} ${escapeHtml(date)}`,
    `<b>${numberOrZero(clan.stars)}⭐ ${formatPercent(getDestructionPercentage(clan))}</b>`,
    "vs",
    `<b>${numberOrZero(opponent.stars)}⭐ ${formatPercent(getDestructionPercentage(opponent))}</b>`,
    escapeHtml(opponent.name || "противник"),
  ].join(" ");
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

function parseRequestedWarCount(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})$/);
  if (!match) return null;

  const count = Number(match[1]);

  if (!Number.isFinite(count) || count <= 0) return null;

  return Math.max(1, Math.min(count, 50));
}

/* -------------------------------------------------------------------------- */
/* Cron                                                                        */
/* -------------------------------------------------------------------------- */

async function handleCron(env) {
  try {
    const result = await runWarWatcher(env, {
      notify: true,
    });

    console.log("Cron war watcher result:", result);
  } catch (e) {
    console.error("Cron war watcher error:", e);
  }
}

/* -------------------------------------------------------------------------- */
/* War watcher                                                                 */
/* -------------------------------------------------------------------------- */

async function runWarWatcher(env, options = {}) {
  const notify = options.notify !== false;
  const chatId = options.chatId || env.WAR_CHAT_ID || "";

  if (!env.DB) {
    throw new Error("D1 binding DB is missing");
  }

  const war = await getCurrentWar(env);

  if (!war || war.state === "notInWar") {
    return {
      ok: true,
      state: "notInWar",
      insertedAttacks: 0,
      notifiedAttacks: 0,
    };
  }

  const warId = getWarId(war);
  const previous = await getWarRecord(env.DB, warId);
  const firstSeen = !previous;
  const previousState = previous && previous.state ? previous.state : "";

  const attacks = collectWarAttacks(war);
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
      await tgSendLongMessage(env, chatId, renderWarAnnouncement(war, env), {
        parse_mode: "HTML",
      });
    }

    return {
      ok: true,
      state: war.state,
      warId,
      firstSeen: true,
      insertedAttacks,
      notifiedAttacks,
    };
  }

  await upsertWarRecord(env.DB, warId, war);

  if (notify && chatId && previousState && previousState !== war.state) {
    stateNotified = await notifyWarStateChanged(env, chatId, war, previousState);
  }

  const newAttacks = [];

  for (const attack of attacks.sort((a, b) => a.orderNo - b.orderNo)) {
    const inserted = await insertAttackIfNew(env.DB, warId, attack);

    if (!inserted) continue;

    insertedAttacks++;
    newAttacks.push(attack);
  }

  if (notify && chatId && newAttacks.length) {
    await tgSendLongMessage(env, chatId, renderAttackBatchMessage(war, newAttacks, env), {
      parse_mode: "HTML",
    });

    notifiedAttacks = newAttacks.length;
  }

  if (notify && chatId) {
    timerNotified = await maybeSendWarTimers(env, chatId, war, {
      skipPeriodicTodo: stateNotified || notifiedAttacks > 0,
    });
  }

  return {
    ok: true,
    state: war.state,
    warId,
    firstSeen: false,
    insertedAttacks,
    notifiedAttacks,
    stateNotified,
    timerNotified,
  };
}

function getWarId(war) {
  const clanTag = war && war.clan && war.clan.tag ? war.clan.tag : "unknownClan";
  const opponentTag = war && war.opponent && war.opponent.tag ? war.opponent.tag : "unknownOpponent";
  const startTime = war && war.startTime ? war.startTime : "unknownStart";

  return `${clanTag}:${opponentTag}:${startTime}`;
}

async function getWarRecord(db, warId) {
  return db
    .prepare("SELECT * FROM wars WHERE war_id = ?")
    .bind(warId)
    .first();
}

async function upsertWarRecord(db, warId, war) {
  const now = new Date().toISOString();

  await db
    .prepare(
      `
      INSERT INTO wars (
        war_id,
        clan_tag,
        opponent_tag,
        opponent_name,
        state,
        preparation_start_time,
        start_time,
        end_time,
        attacks_per_member,
        raw_json,
        created_at,
        updated_at
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
      `
    )
    .bind(
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
    )
    .run();
}

function collectWarAttacks(war) {
  const warId = getWarId(war);
  const ourMembers = (war.clan && war.clan.members) || [];
  const enemyMembers = (war.opponent && war.opponent.members) || [];

  const byTag = new Map();

  for (const member of ourMembers) {
    byTag.set(member.tag, {
      ...member,
      side: "our",
    });
  }

  for (const member of enemyMembers) {
    byTag.set(member.tag, {
      ...member,
      side: "enemy",
    });
  }

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
  const existing = await db
    .prepare("SELECT attack_key FROM attacks WHERE attack_key = ?")
    .bind(attack.attackKey)
    .first();

  if (existing) return false;

  try {
    await db
      .prepare(
        `
        INSERT INTO attacks (
          attack_key,
          war_id,
          attacker_tag,
          attacker_name,
          defender_tag,
          defender_name,
          stars,
          destruction_percentage,
          order_no,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
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
      )
      .run();

    return true;
  } catch (e) {
    if (String((e && e.message) || e).includes("UNIQUE")) {
      return false;
    }

    throw e;
  }
}

async function notifyWarStateChanged(env, chatId, war, previousState) {
  if (war.state === "inWar") {
    await tgSendLongMessage(
      env,
      chatId,
      [
        "⚔️ <b>Война началась!</b>",
        "",
        renderScoreLine(war),
        "",
        renderAttacksLeftLine(war),
        "",
        renderTodoBlock(war, 40),
      ].join("\n"),
      { parse_mode: "HTML" }
    );

    return true;
  }

  if (war.state === "warEnded") {
    await tgSendLongMessage(
      env,
      chatId,
      [
        "🏁 <b>Война закончилась!</b>",
        "",
        renderWarSummaryText(war, env),
      ].join("\n"),
      { parse_mode: "HTML" }
    );

    return true;
  }

  if (war.state === "preparation") {
    await tgSendLongMessage(env, chatId, renderWarAnnouncement(war, env), {
      parse_mode: "HTML",
    });

    return true;
  }

  console.log("War state changed:", {
    previousState,
    nextState: war.state,
  });

  return false;
}

/* -------------------------------------------------------------------------- */
/* War timers                                                                  */
/* -------------------------------------------------------------------------- */

async function maybeSendWarTimers(env, chatId, war, options = {}) {
  if (!war || !war.state) return false;

  let sentImportantTimer = false;

  if (war.state === "preparation") {
    sentImportantTimer = await maybeSendTimeReminder(env, chatId, war, {
      type: "start",
      target: parseCocTime(war.startTime),
      thresholds: [360, 180, 60, 15],
    });

    return sentImportantTimer;
  }

  if (war.state === "inWar") {
    sentImportantTimer = await maybeSendTimeReminder(env, chatId, war, {
      type: "end",
      target: parseCocTime(war.endTime),
      thresholds: [720, 360, 180, 60, 30, 10],
    });

    if (sentImportantTimer) return true;

    if (options.skipPeriodicTodo) return false;

    return maybeSendPeriodicTodoReminder(env, chatId, war);
  }

  return false;
}

async function maybeSendTimeReminder(env, chatId, war, config) {
  if (!config.target) return false;

  const warId = getWarId(war);
  const remainingMinutes = Math.ceil((config.target.getTime() - Date.now()) / 60000);

  if (remainingMinutes <= 0) return false;

  const thresholds = [...config.thresholds].sort((a, b) => b - a);

  for (let i = 0; i < thresholds.length; i++) {
    const threshold = thresholds[i];
    const nextThreshold = thresholds[i + 1] || 0;

    if (remainingMinutes <= threshold && remainingMinutes > nextThreshold) {
      const kind = `${config.type}_${threshold}`;

      const alreadySent = await isReminderSent(env.DB, warId, kind);
      if (alreadySent) return false;

      const text = config.type === "start"
        ? renderStartReminder(war, remainingMinutes, env)
        : renderEndReminder(war, remainingMinutes, env);

      await tgSendLongMessage(env, chatId, text, {
        parse_mode: "HTML",
      });

      await markReminderSent(env.DB, warId, kind);
      return true;
    }
  }

  return false;
}

async function maybeSendPeriodicTodoReminder(env, chatId, war) {
  if (String(env.PERIODIC_TODO_ENABLED || "true").toLowerCase() === "false") {
    return false;
  }

  const attacksLeft = getOurAttacksLeft(war);

  if (attacksLeft <= 0) return false;

  const endTime = parseCocTime(war.endTime);
  const remainingMinutes = endTime
    ? Math.ceil((endTime.getTime() - Date.now()) / 60000)
    : 999999;

  if (remainingMinutes <= 0) return false;

  const lateWindowMinutes = getNumberEnv(env, "TODO_REMINDER_LATE_WINDOW_MINUTES", 360);
  const earlyIntervalMinutes = getNumberEnv(env, "TODO_REMINDER_EARLY_MINUTES", 180);
  const lateIntervalMinutes = getNumberEnv(env, "TODO_REMINDER_LATE_MINUTES", 60);

  const intervalMinutes = remainingMinutes <= lateWindowMinutes
    ? lateIntervalMinutes
    : earlyIntervalMinutes;

  const bucket = Math.floor(Date.now() / (intervalMinutes * 60000));
  const kind = `todo_${intervalMinutes}_${bucket}`;

  const warId = getWarId(war);
  const alreadySent = await isReminderSent(env.DB, warId, kind);

  if (alreadySent) return false;

  await tgSendLongMessage(env, chatId, renderPeriodicTodoReminder(war, remainingMinutes, env), {
    parse_mode: "HTML",
  });

  await markReminderSent(env.DB, warId, kind);

  return true;
}

async function isReminderSent(db, warId, kind) {
  const row = await db
    .prepare("SELECT kind FROM reminders WHERE war_id = ? AND kind = ?")
    .bind(warId, kind)
    .first();

  return Boolean(row);
}

async function markReminderSent(db, warId, kind) {
  await db
    .prepare(
      `
      INSERT OR IGNORE INTO reminders (war_id, kind, sent_at)
      VALUES (?, ?, ?)
      `
    )
    .bind(warId, kind, new Date().toISOString())
    .run();
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function renderWarStatus(war, env) {
  if (!war || war.state === "notInWar") {
    return [
      "⚔️ <b>Текущая война</b>",
      "",
      "Клан сейчас не в войне.",
    ].join("\n");
  }

  const lines = [
    "⚔️ <b>Текущая война</b>",
    "",
    renderWarTitleLine(war),
    "",
    `Состояние: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    `Размер: <b>${numberOrZero(war.teamSize)}x${numberOrZero(war.teamSize)}</b>`,
    `Атак на игрока: <b>${numberOrZero(war.attacksPerMember)}</b>`,
    "",
    renderScoreLine(war),
    renderDestructionLine(war),
    renderAttacksLeftLine(war),
  ];

  if (war.preparationStartTime) {
    lines.push("");
    lines.push(`Подготовка: <b>${escapeHtml(formatCocTime(war.preparationStartTime, env))}</b>`);
  }

  if (war.startTime) {
    lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  }

  if (war.endTime) {
    lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);
  }

  lines.push("");
  lines.push(renderTodoBlock(war, 40));

  return lines.join("\n");
}

function renderWarAnnouncement(war, env) {
  const opponent = war.opponent || {};

  const lines = [
    "⚔️ <b>Война найдена</b>",
    "",
    `Противник: <b>${escapeHtml(opponent.name || "неизвестно")}</b>`,
    `Тег: <code>${escapeHtml(opponent.tag || "-")}</code>`,
    `Статус: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    `Размер: <b>${numberOrZero(war.teamSize)}x${numberOrZero(war.teamSize)}</b>`,
    `Атак на игрока: <b>${numberOrZero(war.attacksPerMember)}</b>`,
  ];

  if (war.startTime) {
    lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  }

  if (war.endTime) {
    lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);
  }

  if (war.state === "preparation") {
    lines.push("");
    lines.push("Бот напомнит перед началом войны.");
  }

  if (war.state === "inWar") {
    lines.push("");
    lines.push(renderScoreLine(war));
    lines.push(renderAttacksLeftLine(war));
    lines.push("");
    lines.push(renderTodoBlock(war, 40));
  }

  return lines.join("\n");
}

function renderAttackBatchMessage(war, attacks, env) {
  const ourCount = attacks.filter((attack) => attack.attackerSide === "our").length;
  const enemyCount = attacks.filter((attack) => attack.attackerSide === "enemy").length;

  const lines = [
    "⚔️ <b>Новые атаки</b>",
    "",
    `Всего новых: <b>${attacks.length}</b>`,
  ];

  if (ourCount) lines.push(`Наших: <b>${ourCount}</b>`);
  if (enemyCount) lines.push(`Противника: <b>${enemyCount}</b>`);

  lines.push("");

  for (const attack of attacks.slice(-25)) {
    lines.push(renderAttackLine(attack));
  }

  if (attacks.length > 25) {
    lines.push("");
    lines.push(`Показаны последние 25 новых атак из ${attacks.length}.`);
  }

  lines.push("");
  lines.push(renderScoreLine(war));
  lines.push(renderAttacksLeftLine(war));

  return lines.join("\n");
}

function renderAttackLine(attack) {
  const icon = attack.attackerSide === "our" ? "🔥" : "🛡";
  const stars = renderStars(attack.stars);

  return [
    `${icon} #${attack.orderNo}`,
    `<b>${escapeHtml(attack.attackerName)}</b> → <b>${escapeHtml(attack.defenderName)}</b>`,
    `${stars} ${formatPercent(attack.destructionPercentage)}`,
  ].join(" ");
}

function renderStartReminder(war, remainingMinutes, env) {
  const opponent = war.opponent || {};

  return [
    `⏳ <b>Скоро начнётся война</b>`,
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
    `⏰ <b>Скоро конец войны</b>`,
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
  return [
    "🕒 <b>Контроль по атакам</b>",
    "",
    `До конца примерно: <b>${escapeHtml(formatMinutesHuman(remainingMinutes))}</b>`,
    "",
    renderScoreLine(war),
    renderAttacksLeftLine(war),
    "",
    renderTodoBlock(war, 50),
  ].join("\n");
}

function renderWarSummaryText(war, env) {
  const lines = [
    "📊 <b>Сводка войны</b>",
    "",
    renderWarTitleLine(war),
    "",
    `Состояние: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    renderScoreLine(war),
    renderDestructionLine(war),
    renderAttacksLeftLine(war),
  ];

  if (war.startTime) {
    lines.push(`Начало: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  }

  if (war.endTime) {
    lines.push(`Конец: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);
  }

  lines.push("");
  lines.push(renderTodoBlock(war, 40));

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

  return [
    `Наши атаки: <b>${ourUsed}/${maxAttacks}</b>, осталось <b>${Math.max(maxAttacks - ourUsed, 0)}</b>`,
    `Атаки противника: <b>${enemyUsed}/${maxAttacks}</b>, осталось <b>${Math.max(maxAttacks - enemyUsed, 0)}</b>`,
  ].join("\n");
}

function renderTodoBlock(war, limit = 40) {
  const ourMembers = (war.clan && war.clan.members) || [];
  const attacksPerMember = numberOrZero(war.attacksPerMember);
  const notAttacked = getNotFullyAttackedMembers(ourMembers, attacksPerMember);

  if (!notAttacked.length) {
    return "✅ <b>Все наши атаки использованы.</b>";
  }

  const lines = [
    "🕒 <b>У кого остались атаки:</b>",
  ];

  for (const item of notAttacked.slice(0, limit)) {
    lines.push(`• #${item.mapPosition} ${escapeHtml(item.name)} — осталось <b>${item.left}</b>`);
  }

  if (notAttacked.length > limit) {
    lines.push(`…и ещё ${notAttacked.length - limit}`);
  }

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* War calculations                                                            */
/* -------------------------------------------------------------------------- */

function countUsedAttacks(members) {
  return (members || []).reduce((sum, member) => {
    return sum + ((member.attacks || []).length);
  }, 0);
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

  return (members || [])
    .map((member) => {
      const used = (member.attacks || []).length;

      return {
        tag: member.tag,
        name: member.name || member.tag || "unknown",
        used,
        left: Math.max(max - used, 0),
        mapPosition: member.mapPosition || 999,
      };
    })
    .filter((member) => member.left > 0)
    .sort((a, b) => {
      if (a.mapPosition !== b.mapPosition) return a.mapPosition - b.mapPosition;
      return a.name.localeCompare(b.name);
    });
}

/* -------------------------------------------------------------------------- */
/* Chat state                                                                  */
/* -------------------------------------------------------------------------- */

async function maybeHandlePendingInput(env, chatId, text) {
  if (!env.DB) return false;

  const value = String(text || "").trim();

  // Чтобы бот в группе не цеплялся за обычный разговор.
  // Реагируем только на чистое число.
  if (!/^\d{1,2}$/.test(value)) return false;

  const state = await getChatState(env.DB, chatId);

  if (!state) return false;

  if (new Date(state.expires_at).getTime() < Date.now()) {
    await clearChatState(env.DB, chatId);
    return false;
  }

  if (state.type !== "awaiting_eff_count") return false;

  await clearChatState(env.DB, chatId);

  const count = parseRequestedWarCount(value) || 10;
  await sendWarEfficiency(env, chatId, count);

  return true;
}

async function getChatState(db, chatId) {
  return db
    .prepare("SELECT * FROM bot_states WHERE chat_id = ?")
    .bind(String(chatId))
    .first();
}

async function setChatState(db, chatId, type, payload = {}, ttlSeconds = 120) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  await db
    .prepare(
      `
      INSERT INTO bot_states (chat_id, type, payload, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        type = excluded.type,
        payload = excluded.payload,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
      `
    )
    .bind(
      String(chatId),
      type,
      JSON.stringify(payload || {}),
      now.toISOString(),
      expiresAt.toISOString()
    )
    .run();
}

async function clearChatState(db, chatId) {
  await db
    .prepare("DELETE FROM bot_states WHERE chat_id = ?")
    .bind(String(chatId))
    .run();
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatWarState(state) {
  const map = {
    preparation: "подготовка",
    inWar: "идёт война",
    warEnded: "война закончилась",
    notInWar: "не в войне",
  };

  return map[state] || state || "неизвестно";
}

function isCoinText(text) {
  const normalized = String(text || "").trim().toLowerCase();

  return (
    normalized === "монетка" ||
    normalized === "кинь монетку" ||
    normalized === "подбрось монетку" ||
    normalized === "coin" ||
    normalized === "flip"
  );
}

async function sendCoinFlip(env, chatId) {
  const isHeads = Math.random() < 0.5;

  const result = isHeads ? "Ореховский (орёл)" : "Hiper (решка)";
  const emoji = isHeads ? "🦅" : "🪙";

  const variants = [
    `${emoji} <b>${result}</b>`,
    `🪙 Монетка решила: <b>${result}</b>`,
    `🎲 Выпало: <b>${result}</b>`,
  ];

  const text = variants[Math.floor(Math.random() * variants.length)];

  await tgSendMessage(env, chatId, text, {
    parse_mode: "HTML",
  });
}

function formatCocTime(value, env) {
  const date = parseCocTime(value);

  if (!date) return String(value || "-");

  const timeZone = env.TIMEZONE || DEFAULT_TIMEZONE;

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parseCocTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);

  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;

  return new Date(Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  ));
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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}