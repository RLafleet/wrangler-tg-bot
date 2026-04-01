/**
 * Telegram lead bot on Cloudflare Workers (webhook).
 * Stack: CF Workers + Telegram Bot API + KV (sessions, leads).
 *
 * Bindings (wrangler.toml):
 * - BOT_TOKEN (secret)
 * - WEBHOOK_SECRET (secret)
 * - SESSIONS (KV)
 * - LEADS (KV)
 * - ADMIN_CHAT_ID (optional, for notifications)
 *
 * UX (не ломать):
 * /start → адрес → выбор сценария → показать, что есть вариант МТС → решение (показать/связаться/номер) → запрос телефона → спасибо.
 */

const CONTACT_USERNAME = "@YOUR_USERNAME";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/") {
      return new Response("ok", { status: 200 });
    }

    const expectedPath = `/webhook/${env.WEBHOOK_SECRET}`;
    if (request.method === "POST" && pathname === expectedPath) {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok", { status: 200 });
    }

    return new Response("not found", { status: 404 });
  },
};

/* ---------- helpers ---------- */

function defaultSession() {
  return {
    step: "start",
    address: "",
    scenario: "",
    phone: "",
    source: "direct",
  };
}

async function loadSession(env, chatId) {
  const raw = await env.SESSIONS.get(chatId.toString());
  return raw ? JSON.parse(raw) : defaultSession();
}

async function saveSession(env, chatId, session) {
  await env.SESSIONS.put(chatId.toString(), JSON.stringify(session), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 days
  });
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...extra, // parse_mode не ставим по умолчанию, чтобы не ломать ввод пользователя
  });
}

async function answerCallback(env, callbackQueryId) {
  try {
    await tg(env, "answerCallbackQuery", { callback_query_id: callbackQueryId });
  } catch (e) {
    console.error("answerCallback error", e);
  }
}

async function tg(env, method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram API error:", data);
    throw new Error(data.description || "Telegram API error");
  }
  return data.result;
}

function parseStartPayload(text) {
  if (!text) return null;
  const parts = text.trim().split(/\s+/);
  if (parts[0].startsWith("/start") && parts[1]) return parts[1];
  return null;
}

function isValidAddress(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 6) return false;
  const hasDigit = /\d/.test(t);
  const hasLetter = /[a-zA-ZА-Яа-яЁё]/.test(t);
  return hasDigit && hasLetter;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  let cleaned = digits;
  if (cleaned.length === 10 && cleaned.startsWith("9")) {
    cleaned = "7" + cleaned;
  }
  if (cleaned.length === 11 && cleaned.startsWith("8")) {
    cleaned = "7" + cleaned.slice(1);
  }
  if (cleaned.length === 11 && cleaned.startsWith("7")) {
    cleaned = cleaned;
  }
  if (cleaned.length !== 11 || !cleaned.startsWith("7")) return null;
  return "+" + cleaned;
}

/* ---------- main handlers ---------- */

async function handleUpdate(update, env) {
  if (update.message) {
    await handleMessage(update.message, env);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, env);
  }
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const session = await loadSession(env, chatId);

  // Contact shortcut (normalize)
  if (msg.contact && session.step === "waiting_phone") {
    if (msg.contact.user_id && msg.from && msg.contact.user_id !== msg.from.id) {
      await sendMessage(env, chatId, "Контакт должен быть вашим. Отправьте свой номер или введите его вручную.");
      await sendPhoneRequest(env, chatId);
      return;
    }
    const normalized = normalizePhone(msg.contact.phone_number);
    if (!normalized) {
      await sendMessage(env, chatId, "Нужен номер в формате +7XXXXXXXXXX. Или отправьте контакт кнопкой ниже.");
      await sendPhoneRequest(env, chatId);
      return;
    }
    session.phone = normalized;
    session.step = "done";
    await saveSession(env, chatId, session);
    await finalizeLead(env, chatId, session, msg, "done");
    return;
  }

  // Reset on /start
  if (text.startsWith("/start")) {
    const payload = parseStartPayload(text);
    session.source = payload || "direct";
    session.step = "waiting_address";
    session.address = "";
    session.scenario = "";
    session.phone = "";
    await saveSession(env, chatId, session);
    await sendMessage(
      env,
      chatId,
      "Здравствуйте!\nЧтобы проверить интернет по вашему адресу, напишите улицу и номер дома — это займет меньше минуты."
    );
    return;
  }

  if (text === "/contact") {
    await sendMessage(env, chatId, `Напишите мне напрямую: ${CONTACT_USERNAME}`);
    return;
  }

  if (text === "/skip" && session.step === "waiting_phone") {
    session.phone = "";
    session.step = "done_without_phone";
    await saveSession(env, chatId, session);
    await finalizeLead(env, chatId, session, msg, "done_without_phone");
    return;
  }

  if (session.step === "waiting_address") {
    if (!isValidAddress(text)) {
      await sendMessage(env, chatId, "Пожалуйста, напишите улицу и номер дома, например: Советская 120.");
      return;
    }
    session.address = text;
    session.step = "waiting_scenario";
    await saveSession(env, chatId, session);
    await sendScenarioButtons(env, chatId);
    return;
  }

  if (session.step === "waiting_phone") {
    const normalized = normalizePhone(text);
    if (!normalized) {
      await sendMessage(env, chatId, "Нужен номер в формате +7XXXXXXXXXX. Или отправьте контакт кнопкой ниже.");
      await sendPhoneRequest(env, chatId);
      return;
    }
    session.phone = normalized;
    session.step = "done";
    await saveSession(env, chatId, session);
    await finalizeLead(env, chatId, session, msg, "done");
    return;
  }

  if (session.step === "done" || session.step === "done_without_phone") {
    await sendMessage(
      env,
      chatId,
      `Если хотите начать заново, отправьте /start.\nЕсли удобнее, напишите мне напрямую: ${CONTACT_USERNAME}`
    );
    return;
  }

  await sendMessage(env, chatId, "Напишите /start, чтобы начать заново.");
}

async function handleCallback(cb, env) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const session = await loadSession(env, chatId);

  await answerCallback(env, cb.id);

  if (data.startsWith("scenario_")) {
    if (session.step !== "waiting_scenario") {
      await sendMessage(env, chatId, "Если хотите начать заново, отправьте /start.");
      return;
    }
    if (data === "scenario_family") {
      session.scenario = "Для квартиры или семьи";
    } else if (data === "scenario_active") {
      session.scenario = "Для активного интернета и нескольких устройств";
    } else if (data === "scenario_only") {
      session.scenario = "Нужен только интернет";
    }
    session.step = "waiting_decision";
    await saveSession(env, chatId, session);
    await sendDecision(env, chatId, session.scenario);
    return;
  }

  if (["show_option", "contact_me", "leave_phone"].includes(data)) {
    if (session.step !== "waiting_decision") {
      await sendMessage(env, chatId, "Если хотите начать заново, отправьте /start.");
      return;
    }
    session.step = "waiting_phone";
    await saveSession(env, chatId, session);

    if (data === "show_option") {
      await sendScenarioStub(env, chatId, session.scenario);
      await sendPhoneRequest(env, chatId);
      return;
    }
    if (data === "contact_me") {
      await sendMessage(
        env,
        chatId,
        `Можете написать мне напрямую: ${CONTACT_USERNAME}\n` +
          "Если удобнее, отправьте номер телефона — я сам свяжусь с вами."
      );
      await sendPhoneRequest(env, chatId);
      return;
    }
    await sendPhoneRequest(env, chatId);
    return;
  }
}

/* ---------- message helpers ---------- */

async function sendScenarioButtons(env, chatId) {
  await sendMessage(env, chatId, "Спасибо. Теперь выберите, что вам нужно:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Для квартиры или семьи", callback_data: "scenario_family" }],
        [{ text: "Для активного интернета", callback_data: "scenario_active" }],
        [{ text: "Нужен только интернет", callback_data: "scenario_only" }],
      ],
    },
  });
}

async function sendDecision(env, chatId, scenarioText) {
  await sendMessage(
    env,
    chatId,
    "По вашему адресу есть подходящий вариант подключения МТС.\n" +
      "Я могу коротко показать, что подойдёт под ваш сценарий, или помочь лично.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Показать вариант", callback_data: "show_option" }],
          [{ text: "Связаться со мной", callback_data: "contact_me" }],
          [{ text: "Оставить номер", callback_data: "leave_phone" }],
        ],
      },
    }
  );
}

async function sendScenarioStub(env, chatId, scenarioText) {
  let stub;
  if (scenarioText === "Для квартиры или семьи") {
    stub = "Для вашего адреса подходит вариант подключения МТС для квартиры или семьи.";
  } else if (scenarioText === "Для активного интернета и нескольких устройств") {
    stub = "Для вашего адреса подходит вариант подключения МТС для активного интернета и нескольких устройств.";
  } else {
    stub = "Для вашего адреса подходит вариант подключения МТС только с интернетом.";
  }
  await sendMessage(env, chatId, `${stub}\nЯ могу коротко объяснить условия и помочь с подключением.`);
}

async function sendPhoneRequest(env, chatId) {
  await sendMessage(
    env,
    chatId,
    "Если удобно, отправьте номер телефона — я свяжусь с вами.\n" +
      `Или можете написать мне напрямую: ${CONTACT_USERNAME}\n` +
      "Если номер оставлять не хотите, отправьте /skip.",
    {
      reply_markup: {
        keyboard: [
          [
            {
              text: "Отправить номер телефона",
              request_contact: true,
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
}

async function notifyAdmin(env, lead) {
  if (!env.ADMIN_CHAT_ID) return;
  const text =
    `Новая заявка\n\n` +
    `Источник: ${lead.source || "-"}\n` +
    `Адрес: ${lead.address || "-"}\n` +
    `Сценарий: ${lead.scenario || "-"}\n` +
    `Телефон: ${lead.phone || "-"}\n` +
    `Username: ${lead.username ? "@" + lead.username : "-"}\n` +
    `Chat ID: ${lead.chatId}\n` +
    `Статус: ${lead.status || "-"}\n` +
    `Создано: ${lead.createdAt}`;
  try {
    await sendMessage(env, env.ADMIN_CHAT_ID, text);
  } catch (e) {
    console.error("Admin notify error", e);
  }
}

async function finalizeLead(env, chatId, session, msg, status = "done") {
  const lead = {
    chatId,
    firstName: msg.chat.first_name || "",
    username: msg.chat.username || "",
    address: session.address,
    scenario: session.scenario,
    phone: session.phone,
    source: session.source,
    status,
    createdAt: new Date().toISOString(),
  };

  const key = `lead:${Date.now()}:${chatId}`;
  await env.LEADS.put(key, JSON.stringify(lead));
  await notifyAdmin(env, lead);

  await sendMessage(
    env,
    chatId,
    "Спасибо! Я свяжусь с вами и помогу с подключением.\n" + `Если удобнее, можете написать мне: ${CONTACT_USERNAME}`,
    { reply_markup: { remove_keyboard: true } }
  );
}
