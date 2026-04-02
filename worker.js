/**
 * Telegram lead bot on Cloudflare Workers (webhook).
 * Stack: CF Workers + Telegram Bot API + KV (sessions, leads).
 *
 * Bindings (wrangler.toml):
 * - BOT_TOKEN (secret)
 * - WEBHOOK_SECRET (secret)
 * - BOT_USERNAME (plain text, without @)
 * - AGENT_CHANNEL_URL (optional, full https://t.me/... link)
 * - TARIFF_FAMILY_FILE_ID (optional)
 * - TARIFF_ACTIVE_FILE_ID (optional)
 * - TARIFF_ONLY_FILE_ID (optional)
 * - SESSIONS (KV)
 * - LEADS (KV)
 * - ADMIN_CHAT_ID (optional, for notifications)
 */

const CONTACT_USERNAME = "@Cerber03w";
const CONTACT_PHONE = "+79877310529";
const REFERRAL_REWARD_TEXT = "500 ₽";
const AGENT_CHANNEL_TEXT = "Официальный Telegram-канал агента МТС Виктора";

// Твой уже полученный file_id.
// Пока используем как дефолтную картинку тарифа.
// Когда получишь еще 1–2 file_id, просто прокинешь их через env.
const DEFAULT_TARIFF_FILE_ID =
    "AgACAgIAAxkBAAOtac5lH-mdwXaSydWEB2ttvVV-hKkAAnoUaxuSZXlKkpDAOEenoyoBAAMCAAN4AAM6BA";

export default {
    async fetch(request, env, ctx) {
        const { pathname } = new URL(request.url);

        const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        const hasSecretHeader = !!secretHeader;

        if (request.method === "GET" && pathname === "/") {
            return new Response("ok", { status: 200 });
        }

        const expectedPath = `/webhook/${env.WEBHOOK_SECRET}`;
        if (request.method === "POST" && pathname === expectedPath) {
            if (hasSecretHeader && secretHeader !== env.WEBHOOK_SECRET) {
                return new Response("forbidden", { status: 403 });
            }

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
        ref_code: "",
        referred_by: "",
        referrals_count: 0,
        referral_reward_status: "pending",
        referral_counted: false,
    };
}

async function loadSession(env, chatId) {
    const raw = await env.SESSIONS.get(chatId.toString());
    if (!raw) return defaultSession();

    try {
        return {...defaultSession(), ...JSON.parse(raw) };
    } catch {
        return defaultSession();
    }
}

async function saveSession(env, chatId, session) {
    await env.SESSIONS.put(chatId.toString(), JSON.stringify(session), {
        expirationTtl: 60 * 60 * 24 * 7,
    });
}

async function sendMessage(env, chatId, text, extra = {}) {
    return tg(env, "sendMessage", {
        chat_id: chatId,
        text,
        ...extra,
    });
}

async function sendPhoto(env, chatId, photo, caption, extra = {}) {
    return tg(env, "sendPhoto", {
        chat_id: chatId,
        photo,
        caption,
        ...extra,
    });
}

async function answerCallback(env, callbackQueryId) {
    try {
        await tg(env, "answerCallbackQuery", {
            callback_query_id: callbackQueryId,
        });
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

async function clearDecisionMessage(env, chatId, messageId) {
    try {
        await tg(env, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: [] },
        });
    } catch (e) {
        console.error("editMessageReplyMarkup error", e);
    }

    try {
        await tg(env, "deleteMessage", {
            chat_id: chatId,
            message_id: messageId,
        });
    } catch (e) {
        console.error("deleteMessage error", e);
    }
}

function parseStartPayload(text) {
    if (!text) return null;
    const parts = text.trim().split(/\s+/);
    if (parts[0].startsWith("/start") && parts[1]) return parts[1];
    return null;
}

function parseSourceAndReferral(payload) {
    if (!payload) return { source: "direct", referred_by: "" };

    // combined form: src_dom1__ref_uabc123
    if (payload.includes("__")) {
        const [left, right] = payload.split("__", 2);
        const source = left.startsWith("src_") ? left.slice(4) : left;
        const referred_by = right.startsWith("ref_") ? right.slice(4) : "";
        return {
            source: source || "direct",
            referred_by: referred_by || "",
        };
    }

    if (payload.startsWith("src_")) {
        return {
            source: payload.slice(4) || "direct",
            referred_by: "",
        };
    }

    if (payload.startsWith("ref_")) {
        return {
            source: "direct",
            referred_by: payload.slice(4) || "",
        };
    }

    return {
        source: payload || "direct",
        referred_by: "",
    };
}

function generateRefCode(chatId) {
    return `u${Number(chatId).toString(36)}`;
}

function parseRefCodeToChatId(refCode) {
    if (!refCode || typeof refCode !== "string" || !/^u[0-9a-z]+$/i.test(refCode)) {
        return null;
    }
    const parsed = parseInt(refCode.slice(1), 36);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function buildReferralLink(env, refCode) {
    const botUsername = env.BOT_USERNAME || "";
    if (!botUsername || !refCode) return "";
    return `https://t.me/${botUsername}?start=ref_${refCode}`;
}

function buildAgentChannelLine(env) {
    if (!env.AGENT_CHANNEL_URL) return "";
    return `${AGENT_CHANNEL_TEXT}: ${env.AGENT_CHANNEL_URL}`;
}

function getTariffPhotoId(env, scenarioText) {
    if (scenarioText === "Для квартиры или семьи") {
        return env.TARIFF_FAMILY_FILE_ID || DEFAULT_TARIFF_FILE_ID;
    }
    if (scenarioText === "Для активного интернета и нескольких устройств") {
        return env.TARIFF_ACTIVE_FILE_ID || DEFAULT_TARIFF_FILE_ID;
    }
    return env.TARIFF_ONLY_FILE_ID || DEFAULT_TARIFF_FILE_ID;
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

    if (cleaned.length !== 11 || !cleaned.startsWith("7")) return null;
    return `+${cleaned}`;
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

    if (msg.contact && session.step === "waiting_phone") {
        if (msg.contact.user_id && msg.from && msg.contact.user_id !== msg.from.id) {
            await sendMessage(
                env,
                chatId,
                "Контакт должен быть вашим. Отправьте свой номер или введите его вручную."
            );
            await sendPhoneRequest(env, chatId);
            return;
        }

        const normalized = normalizePhone(msg.contact.phone_number);
        if (!normalized) {
            await sendMessage(
                env,
                chatId,
                "Нужен номер в формате +7XXXXXXXXXX. Или отправьте контакт кнопкой ниже."
            );
            await sendPhoneRequest(env, chatId);
            return;
        }

        session.phone = normalized;
        session.step = "done";
        await saveSession(env, chatId, session);
        await finalizeLead(env, chatId, session, msg, "done");
        return;
    }

    if (text.startsWith("/start")) {
        const payload = parseStartPayload(text);
        const { source, referred_by } = parseSourceAndReferral(payload);

        session.source = source || "direct";
        session.referred_by = referred_by || "";
        session.ref_code = session.ref_code || generateRefCode(chatId);

        // защита от self-referral
        if (session.ref_code && session.referred_by && session.ref_code === session.referred_by) {
            session.referred_by = "";
        }

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
        await sendMessage(
            env,
            chatId,
            `Напишите мне напрямую: ${CONTACT_USERNAME}\nИли позвоните: ${CONTACT_PHONE}`
        );
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
            await sendMessage(
                env,
                chatId,
                "Пожалуйста, напишите улицу и номер дома, например: Советская 120."
            );
            return;
        }

        session.address = text.trim();
        session.step = "waiting_scenario";
        await saveSession(env, chatId, session);
        await sendScenarioButtons(env, chatId);
        return;
    }

    if (session.step === "waiting_phone") {
        const normalized = normalizePhone(text);
        if (!normalized) {
            await sendMessage(
                env,
                chatId,
                "Нужен номер в формате +7XXXXXXXXXX. Или отправьте контакт кнопкой ниже."
            );
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

        await clearDecisionMessage(env, chatId, cb.message.message_id);
        await sendDecision(env, chatId);
        return;
    }

    if (["show_option", "contact_me", "leave_phone"].includes(data)) {
        if (session.step !== "waiting_decision") {
            await sendMessage(env, chatId, "Если хотите начать заново, отправьте /start.");
            return;
        }

        session.step = "waiting_phone";
        await saveSession(env, chatId, session);

        await clearDecisionMessage(env, chatId, cb.message.message_id);

        if (data === "show_option") {
            await sendShowOptionAndPhoneRequest(env, chatId, session.scenario);
            return;
        }

        if (data === "contact_me") {
            const channelLine = buildAgentChannelLine(env);
            let text =
                `Можете написать мне напрямую: ${CONTACT_USERNAME}\n` +
                `Или позвонить: ${CONTACT_PHONE}\n` +
                "Подключение бесплатно для вас, первый месяц я оплачиваю сам.\n" +
                "Если удобнее, отправьте номер телефона — я сам свяжусь с вами.";

            if (channelLine) {
                text += `\n${channelLine}`;
            }

            await sendMessage(env, chatId, text);
            await sendPhoneRequest(env, chatId);
            return;
        }

        await sendPhoneRequest(env, chatId);
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

async function sendDecision(env, chatId) {
    await sendMessage(
        env,
        chatId,
        "По вашему адресу есть подходящий вариант подключения МТС.\n" +
        "Я могу коротко показать условия и мой личный бонус при подключении.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Показать вариант и условия", callback_data: "show_option" }],
                    [{ text: "Связаться со мной", callback_data: "contact_me" }],
                    [{ text: "Оставить номер", callback_data: "leave_phone" }],
                ],
            },
        }
    );
}

async function sendPhoneRequest(env, chatId) {
    await sendMessage(
        env,
        chatId,
        "Если удобно, отправьте номер телефона — я свяжусь с вами.\n" +
        `Или можете написать мне напрямую: ${CONTACT_USERNAME}\n` +
        `Или позвонить: ${CONTACT_PHONE}\n` +
        "Если номер оставлять не хотите, отправьте /skip.", {
            reply_markup: {
                keyboard: [
                    [{
                        text: "Отправить номер телефона",
                        request_contact: true,
                    }, ],
                ],
                resize_keyboard: true,
                one_time_keyboard: true,
            },
        }
    );
}

async function sendShowOptionAndPhoneRequest(env, chatId, scenarioText) {
    let stub;
    if (scenarioText === "Для квартиры или семьи") {
        stub = "Для вашего адреса подходит вариант подключения МТС для квартиры или семьи.";
    } else if (scenarioText === "Для активного интернета и нескольких устройств") {
        stub = "Для вашего адреса подходит вариант подключения МТС для активного интернета и нескольких устройств.";
    } else {
        stub = "Для вашего адреса подходит вариант подключения МТС только с интернетом.";
    }

    const channelLine = buildAgentChannelLine(env);

    let text =
        `${stub}\n` +
        "Для вас подключение бесплатно, и первый месяц я оплачиваю сам.\n" +
        "Со 2 по 4 месяц стоимость составит 475 ₽/мес, далее — 950 ₽/мес.";

    if (channelLine) {
        text += `\n${channelLine}`;
    }

    text +=
        `\n\nЕсли удобно, отправьте номер телефона — я свяжусь с вами.\n` +
        `Или можете написать мне напрямую: ${CONTACT_USERNAME}\n` +
        `Или позвонить: ${CONTACT_PHONE}\n` +
        "Если номер оставлять не хотите, отправьте /skip.";

    const replyMarkup = {
        keyboard: [
            [{
                text: "Отправить номер телефона",
                request_contact: true,
            }, ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
    };

    const photoId = getTariffPhotoId(env, scenarioText);

    if (photoId) {
        await sendPhoto(env, chatId, photoId, text, {
            reply_markup: replyMarkup,
        });
        return;
    }

    await sendMessage(env, chatId, text, {
        reply_markup: replyMarkup,
    });
}

async function sendReferralMessage(env, chatId, session) {
    const refCode = session.ref_code || generateRefCode(chatId);
    const refLink = buildReferralLink(env, refCode);

    let text =
        `Если порекомендуете меня знакомому и он подключится, переведу вам ${REFERRAL_REWARD_TEXT}.\n` +
        `Ваш код рекомендации: ${refCode}`;

    if (refLink) {
        text += `\nВаша ссылка: ${refLink}`;
    }

    text +=
        "\nЕсли знакомому удобнее сразу позвонить, пусть скажет ваш код рекомендации.";

    await sendMessage(env, chatId, text);
}

async function registerReferralLead(env, chatId, session) {
    if (!session.referred_by) return;
    if (session.referral_counted) return;

    const referrerChatId = parseRefCodeToChatId(session.referred_by);
    if (!referrerChatId) return;

    const referrerSession = await loadSession(env, referrerChatId);
    referrerSession.ref_code = referrerSession.ref_code || generateRefCode(referrerChatId);
    referrerSession.referrals_count = (referrerSession.referrals_count || 0) + 1;
    await saveSession(env, referrerChatId, referrerSession);

    session.referral_counted = true;
    await saveSession(env, chatId, session);
}

async function notifyAdmin(env, lead) {
    if (!env.ADMIN_CHAT_ID) return;

    const text =
        `Новая заявка\n\n` +
        `Источник: ${lead.source || "-"}\n` +
        `Referral from: ${lead.referred_by || "-"}\n` +
        `Ref code: ${lead.ref_code || "-"}\n` +
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
        ref_code: session.ref_code || generateRefCode(chatId),
        referred_by: session.referred_by || "",
        referral_reward_status: session.referral_reward_status || "pending",
        status,
        createdAt: new Date().toISOString(),
    };

    const key = `lead:${Date.now()}:${chatId}`;
    await env.LEADS.put(key, JSON.stringify(lead));
    await notifyAdmin(env, lead);
    await registerReferralLead(env, chatId, session);

    await sendMessage(
        env,
        chatId,
        "Спасибо! Я свяжусь с вами и помогу с подключением.\n" +
        `Если удобнее, можете написать мне: ${CONTACT_USERNAME}\n` +
        `Или позвонить: ${CONTACT_PHONE}`, {
            reply_markup: { remove_keyboard: true },
        }
    );

    await sendReferralMessage(env, chatId, session);
}