var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var worker_default = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/") {
      return jsonResponse({
        ok: true,
        service: "coc-war-tg-bot"
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
  }
};
async function tg(env, method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Telegram API error:", data);
    throw new Error(data.description || "Telegram API error");
  }
  return data.result;
}
__name(tg, "tg");
async function tgSendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra
  });
}
__name(tgSendMessage, "tgSendMessage");
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
      chatId,
      [
        "ID \u044D\u0442\u043E\u0433\u043E \u0447\u0430\u0442\u0430:",
        `<code>${escapeHtml(String(chatId))}</code>`,
        "",
        "\u0415\u0441\u043B\u0438 \u044D\u0442\u043E \u0433\u0440\u0443\u043F\u043F\u0430 \u043A\u043B\u0430\u043D\u0430 \u2014 \u044D\u0442\u043E\u0442 ID \u043F\u043E\u0442\u043E\u043C \u043C\u043E\u0436\u043D\u043E \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0432 WAR_CHAT_ID."
      ].join("\n"),
      { parse_mode: "HTML" }
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
    "\u041D\u0435 \u043F\u043E\u043D\u044F\u043B \u043A\u043E\u043C\u0430\u043D\u0434\u0443. \u041D\u0430\u043F\u0438\u0448\u0438 /help."
  );
}
__name(handleTelegramUpdate, "handleTelegramUpdate");
function isCommand(text, command) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized === `/${command}` || normalized.startsWith(`/${command}@`);
}
__name(isCommand, "isCommand");
async function sendHelp(env, chatId) {
  const text = [
    "\u2694\uFE0F CoC War Bot",
    "",
    "\u041A\u043E\u043C\u0430\u043D\u0434\u044B:",
    "/status \u2014 \u0442\u0435\u043A\u0443\u0449\u0430\u044F \u0432\u043E\u0439\u043D\u0430",
    "/chatid \u2014 \u0443\u0437\u043D\u0430\u0442\u044C ID \u044D\u0442\u043E\u0433\u043E \u0447\u0430\u0442\u0430",
    "/ping \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C, \u0447\u0442\u043E \u0431\u043E\u0442 \u0436\u0438\u0432\u043E\u0439",
    "/help \u2014 \u043F\u043E\u043C\u043E\u0449\u044C",
    "",
    "\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u043C \u0448\u0430\u0433\u043E\u043C \u0434\u043E\u0431\u0430\u0432\u0438\u043C \u0431\u0430\u0437\u0443, \u043D\u043E\u0432\u044B\u0435 \u0430\u0442\u0430\u043A\u0438 \u0438 \u043D\u0430\u043F\u043E\u043C\u0438\u043D\u0430\u043D\u0438\u044F."
  ].join("\n");
  await tgSendMessage(env, chatId, text);
}
__name(sendHelp, "sendHelp");
function getCocApiBase(env) {
  return String(env.COC_API_BASE || "https://api.clashofclans.com/v1").replace(/\/+$/, "");
}
__name(getCocApiBase, "getCocApiBase");
function encodeTag(tag) {
  const normalized = String(tag || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error("CLAN_TAG is empty");
  }
  const withHash = normalized.startsWith("#") ? normalized : `#${normalized}`;
  return encodeURIComponent(withHash);
}
__name(encodeTag, "encodeTag");
async function cocGet(env, path) {
  const url = `${getCocApiBase(env)}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.SUPERCELL_KEY}`,
      Accept: "application/json"
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = data && (data.reason || data.message) ? `${data.reason || ""} ${data.message || ""}`.trim() : "";
    throw new Error(`CoC API ${res.status}${reason ? `: ${reason}` : ""}`);
  }
  return data;
}
__name(cocGet, "cocGet");
async function getCurrentWar(env) {
  const clanTag = encodeTag(env.CLAN_TAG);
  return cocGet(env, `/clans/${clanTag}/currentwar`);
}
__name(getCurrentWar, "getCurrentWar");
async function sendWarStatus(env, chatId) {
  try {
    const war = await getCurrentWar(env);
    const text = renderWarStatus(war, env);
    await tgSendMessage(env, chatId, text, {
      parse_mode: "HTML"
    });
  } catch (e) {
    console.error("sendWarStatus error:", e);
    await tgSendMessage(
      env,
      chatId,
      [
        "\u041D\u0435 \u0441\u043C\u043E\u0433 \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u0432\u043E\u0439\u043D\u0443.",
        "",
        `\u041E\u0448\u0438\u0431\u043A\u0430: <code>${escapeHtml(e.message || String(e))}</code>`,
        "",
        "\u041F\u0440\u043E\u0432\u0435\u0440\u044C:",
        "1. CLAN_TAG \u0443\u043A\u0430\u0437\u0430\u043D \u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E.",
        "2. SUPERCELL_KEY \u0436\u0438\u0432\u043E\u0439.",
        "3. \u0412 API-\u043A\u043B\u044E\u0447\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043D \u043D\u0443\u0436\u043D\u044B\u0439 IP/proxy.",
        "4. War log \u0443 \u043A\u043B\u0430\u043D\u0430 \u043E\u0442\u043A\u0440\u044B\u0442, \u0435\u0441\u043B\u0438 API \u044D\u0442\u043E\u0433\u043E \u0442\u0440\u0435\u0431\u0443\u0435\u0442."
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  }
}
__name(sendWarStatus, "sendWarStatus");
function renderWarStatus(war, env) {
  if (!war || war.state === "notInWar") {
    return [
      "\u2694\uFE0F <b>\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0432\u043E\u0439\u043D\u0430</b>",
      "",
      "\u041A\u043B\u0430\u043D \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435 \u0432 \u0432\u043E\u0439\u043D\u0435."
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
    "\u2694\uFE0F <b>\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0432\u043E\u0439\u043D\u0430</b>",
    "",
    `<b>${escapeHtml(ourClan.name || "\u041D\u0430\u0448 \u043A\u043B\u0430\u043D")}</b> vs <b>${escapeHtml(enemyClan.name || "\u041F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A")}</b>`,
    "",
    `\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435: <b>${escapeHtml(formatWarState(war.state))}</b>`,
    `\u0420\u0430\u0437\u043C\u0435\u0440: <b>${teamSize}x${teamSize}</b>`,
    `\u0410\u0442\u0430\u043A \u043D\u0430 \u0438\u0433\u0440\u043E\u043A\u0430: <b>${attacksPerMember}</b>`,
    "",
    `\u2B50 \u0417\u0432\u0451\u0437\u0434\u044B: <b>${ourStars}</b> \u2014 <b>${enemyStars}</b>`,
    `\u{1F4A5} \u0420\u0430\u0437\u0440\u0443\u0448\u0435\u043D\u0438\u0435: <b>${ourDestruction}</b> \u2014 <b>${enemyDestruction}</b>`,
    "",
    `\u041D\u0430\u0448\u0438 \u0430\u0442\u0430\u043A\u0438: <b>${ourUsedAttacks}/${maxAttacks}</b>`,
    `\u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u043D\u0430\u0448\u0438\u0445 \u0430\u0442\u0430\u043A: <b>${ourLeft}</b>`,
    "",
    `\u0410\u0442\u0430\u043A\u0438 \u043F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A\u0430: <b>${enemyUsedAttacks}/${maxAttacks}</b>`,
    `\u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C \u0430\u0442\u0430\u043A \u043F\u0440\u043E\u0442\u0438\u0432\u043D\u0438\u043A\u0430: <b>${enemyLeft}</b>`
  ];
  if (war.preparationStartTime) {
    lines.push("", `\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430 \u043D\u0430\u0447\u0430\u043B\u0430\u0441\u044C: <b>${escapeHtml(formatCocTime(war.preparationStartTime, env))}</b>`);
  }
  if (war.startTime) {
    lines.push(`\u041D\u0430\u0447\u0430\u043B\u043E \u0432\u043E\u0439\u043D\u044B: <b>${escapeHtml(formatCocTime(war.startTime, env))}</b>`);
  }
  if (war.endTime) {
    lines.push(`\u041A\u043E\u043D\u0435\u0446 \u0432\u043E\u0439\u043D\u044B: <b>${escapeHtml(formatCocTime(war.endTime, env))}</b>`);
  }
  const notAttacked = getNotFullyAttackedMembers(ourMembers, attacksPerMember);
  if (notAttacked.length) {
    lines.push("");
    lines.push("\u{1F552} <b>\u0423 \u043A\u043E\u0433\u043E \u043E\u0441\u0442\u0430\u043B\u0438\u0441\u044C \u0430\u0442\u0430\u043A\u0438:</b>");
    for (const item of notAttacked.slice(0, 30)) {
      lines.push(
        `\u2022 ${escapeHtml(item.name)} \u2014 \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C <b>${item.left}</b>`
      );
    }
    if (notAttacked.length > 30) {
      lines.push(`\u2026\u0438 \u0435\u0449\u0451 ${notAttacked.length - 30}`);
    }
  }
  return lines.join("\n");
}
__name(renderWarStatus, "renderWarStatus");
function formatWarState(state) {
  const map = {
    preparation: "\u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0430",
    inWar: "\u0438\u0434\u0451\u0442 \u0432\u043E\u0439\u043D\u0430",
    warEnded: "\u0432\u043E\u0439\u043D\u0430 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u043B\u0430\u0441\u044C",
    notInWar: "\u043D\u0435 \u0432 \u0432\u043E\u0439\u043D\u0435"
  };
  return map[state] || state || "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E";
}
__name(formatWarState, "formatWarState");
function countUsedAttacks(members) {
  return (members || []).reduce((sum, member) => {
    return sum + (member.attacks || []).length;
  }, 0);
}
__name(countUsedAttacks, "countUsedAttacks");
function getNotFullyAttackedMembers(members, attacksPerMember) {
  const max = Number(attacksPerMember || 0);
  if (!max) return [];
  return (members || []).map((member) => {
    const used = (member.attacks || []).length;
    return {
      tag: member.tag,
      name: member.name || member.tag || "unknown",
      used,
      left: Math.max(max - used, 0),
      mapPosition: member.mapPosition || 999
    };
  }).filter((member) => member.left > 0).sort((a, b) => {
    if (a.mapPosition !== b.mapPosition) return a.mapPosition - b.mapPosition;
    return a.name.localeCompare(b.name);
  });
}
__name(getNotFullyAttackedMembers, "getNotFullyAttackedMembers");
async function handleCron(env) {
  try {
    const war = await getCurrentWar(env);
    console.log("Cron war check:", {
      state: war.state,
      clan: war.clan && war.clan.name,
      opponent: war.opponent && war.opponent.name,
      startTime: war.startTime,
      endTime: war.endTime
    });
  } catch (e) {
    console.error("Cron war check error:", e);
  }
}
__name(handleCron, "handleCron");
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
    minute: "2-digit"
  }).format(date);
}
__name(formatCocTime, "formatCocTime");
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
__name(parseCocTime, "parseCocTime");
function formatPercent(value) {
  const number = Number(value || 0);
  return `${number.toFixed(2)}%`;
}
__name(formatPercent, "formatPercent");
function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
__name(numberOrZero, "numberOrZero");
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escapeHtml, "escapeHtml");
function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...init.headers || {}
    }
  });
}
__name(jsonResponse, "jsonResponse");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
