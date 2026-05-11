/**
 * Clash of Clans Telegram war bot for Cloudflare Workers.
 *
 * MVP-0:
 * - Telegram webhook: POST /webhook/<WEBHOOK_SECRET>
 * - Commands:
 *   /start
 *   /help
 *   /chatid
 *   /status
 *   /ping
 * - Cloudflare Cron: scheduled()
 *
 * Required secrets:
 * - BOT_TOKEN
 * - WEBHOOK_SECRET
 * - SUPERCELL_KEY
 *
 * Required vars:
 * - CLAN_TAG
 * - COC_API_BASE
 *
 * Optional vars/secrets:
 * - WAR_CHAT_ID
 * - TIMEZONE
 */

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

async function handleTelegramUpdate(update, env) {
    if (!update.message) return;

    const msg = update.message;
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();

    if (!text) return;

    if (isCommand(text, "start") || isCommand(text, "help")) {
        await sendHelp(env, chatId);
        return;
    }

    if (isCommand(text, "ping")) {
        await tgSendMessage(env, chatId, "pong");
        return;
    }

    if (isCommand(text, "chatid")) {
        await tgSendMessage(
            env,
            chatId, [
                "ID этого чата:",
                `<code>${escapeHtml(String(chatId))}</code>`,
                "",
                "Если это группа клана — этот ID потом можно поставить в WAR_CHAT_ID.",
            ].join("\n"), { parse_mode: "HTML" }
        );
        return;
    }

    if (isCommand(text, "status")) {
        await sendWarStatus(env, chatId);
        return;
    }

    await tgSendMessage(
        env,
        chatId,
        "Не понял команду. Напиши /help."
    );
}

function isCommand(text, command) {
    const normalized = String(text || "").trim().toLowerCase();

    return (
        normalized === `/${command}` ||
        normalized.startsWith(`/${command}@`)
    );
}

async function sendHelp(env, chatId) {
    const text = [
        "⚔️ CoC War Bot",
        "",
        "Команды:",
        "/status — текущая война",
        "/chatid — узнать ID этого чата",
        "/ping — проверить, что бот живой",
        "/help — помощь",
        "",
        "Следующим шагом добавим базу, новые атаки и напоминания.",
    ].join("\n");

    await tgSendMessage(env, chatId, text);
}

/* -------------------------------------------------------------------------- */
/* Clash of Clans API                                                          */
/* -------------------------------------------------------------------------- */

function getCocApiBase(env) {
    return String(env.COC_API_BASE || "https://api.clashofclans.com/v1").replace(/\/+$/, "");
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
        const reason = data && (data.reason || data.message) ? `${data.reason || ""} ${data.message || ""}`.trim() : "";
        throw new Error(`CoC API ${res.status}${reason ? `: ${reason}` : ""}`);
  }

  return data;
}

async function getCurrentWar(env) {
  const clanTag = encodeTag(env.CLAN_TAG);
  return cocGet(env, `/clans/${clanTag}/currentwar`);
}

/* -------------------------------------------------------------------------- */
/* War rendering                                                               */
/* -------------------------------------------------------------------------- */

async function sendWarStatus(env, chatId) {
  try {
    const war = await getCurrentWar(env);
    const text = renderWarStatus(war, env);

    await tgSendMessage(env, chatId, text, {
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
        "Проверь:",
        "1. CLAN_TAG указан правильно.",
        "2. SUPERCELL_KEY живой.",
        "3. В API-ключе разрешён нужный IP/proxy.",
        "4. War log у клана открыт, если API этого требует.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}

function renderWarStatus(war, env) {
  if (!war || war.state === "notInWar") {
    return [
      "⚔️ <b>Текущая война</b>",
      "",
      "Клан сейчас не в войне.",
    ].join("\n");
  }

  const ourClan = war.clan || {};
  const enemyClan = war.opponent || {};

  const ourStars = numberOrZero(ourClan.stars);
  const enemyStars = numberOrZero(enemyClan.stars);

  const ourDestruction = formatPercent(ourClan.destructionPercentage);
  const enemyDestruction = formatPercent(enemyClan.destructionPercentage);

  const attacksPerMember = numberOrZero(war.attacksPerMember);
  const teamSize = numberOrZero(war.teamSize);

  const ourMembers = ourClan.members || [];
  const enemyMembers = enemyClan.members || [];

  const ourUsedAttacks = countUsedAttacks(ourMembers);
  const enemyUsedAttacks = countUsedAttacks(enemyMembers);

  const maxAttacks = teamSize * attacksPerMember;
  const ourLeft = Math.max(maxAttacks - ourUsedAttacks, 0);
  const enemyLeft = Math.max(maxAttacks - enemyUsedAttacks, 0);

  const lines = [
    "⚔️ <b>Текущая война</b>",
    "",
    `<b>${escapeHtml(ourClan.name || "Наш клан")}</b> vs <b>${escapeHtml(enemyClan.name || "Противник")}</b>`,
    "",
    `Состояние: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    `Размер: <b>${teamSize}x${teamSize}</b>`,
    `Атак на игрока: <b>${attacksPerMember}</b>`,
    "",
    `⭐ Звёзды: <b>${ourStars}</b> — <b>${enemyStars}</b>`,
    `💥 Разрушение: <b>${ourDestruction}</b> — <b>${enemyDestruction}</b>`,
    "",
    `Наши атаки: <b>${ourUsedAttacks}/${maxAttacks}</b>`,
    `Осталось наших атак: <b>${ourLeft}</b>`,
    "",
    `Атаки противника: <b>${enemyUsedAttacks}/${maxAttacks}</b>`,
    `Осталось атак противника: <b>${enemyLeft}</b>`,
  ];

  if (war.preparationStartTime) {
    lines.push("", `Подготовка началась: <b>${escapeHtml(formatCocTime(war.preparationStartTime, env))}</b>`);
  }

  if (war.startTime) {
    lines.push(`Начало войны: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  }

  if (war.endTime) {
    lines.push(`Конец войны: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);
  }

  const notAttacked = getNotFullyAttackedMembers(ourMembers, attacksPerMember);

  if (notAttacked.length) {
    lines.push("");
    lines.push("🕒 <b>У кого остались атаки:</b>");

    for (const item of notAttacked.slice(0, 30)) {
      lines.push(
        `• ${escapeHtml(item.name)} — осталось <b>${item.left}</b>`
      );
    }

    if (notAttacked.length > 30) {
      lines.push(`…и ещё ${notAttacked.length - 30}`);
    }
  }

  return lines.join("\n");
}

function formatWarState(state) {
  const map = {
    preparation: "подготовка",
    inWar: "идёт война",
    warEnded: "война закончилась",
    notInWar: "не в войне",
  };

  return map[state] || state || "неизвестно";
}

function countUsedAttacks(members) {
  return (members || []).reduce((sum, member) => {
    return sum + ((member.attacks || []).length);
  }, 0);
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
/* Cron                                                                        */
/* -------------------------------------------------------------------------- */

async function handleCron(env) {
  try {
    const war = await getCurrentWar(env);

    console.log("Cron war check:", {
      state: war.state,
      clan: war.clan && war.clan.name,
      opponent: war.opponent && war.opponent.name,
      startTime: war.startTime,
      endTime: war.endTime,
    });

    // Пока не шлём сообщения автоматически, чтобы не спамить.
    // На следующем шаге добавим D1 и будем понимать:
    // - новую войну,
    // - новые атаки,
    // - уже отправленные напоминания.
  } catch (e) {
    console.error("Cron war check error:", e);
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

function formatCocTime(value, env) {
  const date = parseCocTime(value);

  if (!date) return String(value || "-");

  const timeZone = env.TIMEZONE || "Europe/Riga";

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

function numberOrZero(value) {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
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