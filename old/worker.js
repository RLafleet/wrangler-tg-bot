/**
 * Multi-channel lead bot for Telegram + VK on Cloudflare Workers.
 *
 * Channels:
 * - Telegram webhook: POST /webhook/<WEBHOOK_SECRET>
 * - VK Callback API: POST /vk/<WEBHOOK_SECRET>
 *
 * Storage:
 * - SESSIONS (KV)
 * - LEADS (KV)
 *
 * Required bindings:
 * - BOT_TOKEN (secret)                  // Telegram bot token
 * - WEBHOOK_SECRET (secret/plain)       // shared route secret for tg + vk endpoints
 * - BOT_USERNAME (plain, optional)      // Telegram bot username without @
 * - SESSIONS (KV)
 * - LEADS (KV)
 *
 * Optional bindings:
 * - ADMIN_CHAT_ID (secret/plain)        // Telegram chat id for notifications
 * - AGENT_CHANNEL_URL (plain)
 * - TARIFF_FAMILY_FILE_ID (plain)       // Telegram file_id
 * - TARIFF_ACTIVE_FILE_ID (plain)       // Telegram file_id
 * - TARIFF_ONLY_FILE_ID (plain)         // Telegram file_id
 *
 * VK bindings:
 * - VK_TOKEN (secret)                   // community token
 * - VK_GROUP_ID (plain)
 * - VK_CONFIRMATION_CODE (plain)
 * - VK_SECRET_KEY (secret/plain)
 * - VK_API_VERSION (plain, e.g. 5.199)
 *
 * Optional VK attachments (already uploaded in VK, e.g. photo-1_2):
 * - VK_TARIFF_FAMILY_ATTACHMENT (plain)
 * - VK_TARIFF_ACTIVE_ATTACHMENT (plain)
 * - VK_TARIFF_ONLY_ATTACHMENT (plain)
 * 
 * - GROUP_CLOSE_FILE_ID (plain)         // Telegram file_id for "группа для близких"
 * - VK_GROUP_CLOSE_ATTACHMENT (plain)   // VK attachment for "группа для близких"
 */

const CONTACT_USERNAME = "@Cerber03w";
const CONTACT_PHONE = "+79877310529";
const REFERRAL_REWARD_TEXT = "500 ₽";
const AGENT_CHANNEL_TEXT = "Официальный Telegram-канал агента МТС, Виктора";

const CHANNEL_TG = "tg";
const CHANNEL_VK = "vk";

const STEP_START = "start";
const STEP_WAITING_ADDRESS = "waiting_address";
const STEP_WAITING_SCENARIO = "waiting_scenario";
const STEP_WAITING_DECISION = "waiting_decision";
const STEP_WAITING_PHONE = "waiting_phone";
const STEP_DONE = "done";
const STEP_DONE_WITHOUT_PHONE = "done_without_phone";

// Telegram fallback images
const DEFAULT_TARIFF_FAMILY_FILE_ID =
    "AgACAgIAAxkBAAOtac5lH-mdwXaSydWEB2ttvVV-hKkAAnoUaxuSZXlKkpDAOEenoyoBAAMCAAN4AAM6BA";
const DEFAULT_TARIFF_ACTIVE_FILE_ID =
    "AgACAgIAAxkBAAOtac5lH-mdwXaSydWEB2ttvVV-hKkAAnoUaxuSZXlKkpDAOEenoyoBAAMCAAN4AAM6BA";
const DEFAULT_TARIFF_ONLY_FILE_ID =
    "AgACAgIAAxkBAAPJac5oqBh1yQ9rj1Y2MZsSK7DuASMAAqgUaxuSZXlKkmSgnPMC1hsBAAMCAAN4AAM6BA";
const DEFAULT_GROUP_CLOSE_FILE_ID =
    "AgACAgIAAxkDAAIBiWnPp1-v9O3IsTbeqv5vRPdKGHqrAAIaFmsbkmWBSruf_ONYqCwuAQADAgADeQADOgQ";

export default {
    async fetch(request, env, ctx) {
        const { pathname } = new URL(request.url);

        if (request.method === "GET" && pathname === "/") {
            return new Response("ok", { status: 200 });
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

        const vkPath = `/vk/${env.WEBHOOK_SECRET}`;
        if (request.method === "POST" && pathname === vkPath) {
            const update = await request.json();

            if (env.VK_SECRET_KEY && update.secret !== env.VK_SECRET_KEY) {
                return new Response("forbidden", { status: 403 });
            }

            if (update.type === "confirmation") {
                return new Response(env.VK_CONFIRMATION_CODE || "", { status: 200 });
            }

            ctx.waitUntil(handleVkUpdate(update, env));
            return new Response("ok", { status: 200 });
        }

        return new Response("not found", { status: 404 });
    },
};

/* -------------------------------------------------------------------------- */
/* session / keys                                                              */
/* -------------------------------------------------------------------------- */

function defaultSession(channel = CHANNEL_TG) {
    return {
        step: STEP_START,
        address: "",
        scenario: "",
        phone: "",
        source: "direct",
        ref_code: "",
        referred_by: "",
        referrals_count: 0,
        referral_reward_status: "pending",
        referral_counted: false,
        channel,
    };
}

function sessionKey(channel, chatId) {
    return `${channel}:${chatId}`;
}

async function loadSession(env, channel, chatId) {
    const raw = await env.SESSIONS.get(sessionKey(channel, chatId));
    if (!raw) return defaultSession(channel);

    try {
        return {...defaultSession(channel), ...JSON.parse(raw), channel };
    } catch {
        return defaultSession(channel);
    }
}

async function saveSession(env, channel, chatId, session) {
    await env.SESSIONS.put(sessionKey(channel, chatId), JSON.stringify(session), {
        expirationTtl: 60 * 60 * 24 * 7,
    });
}

function generateRefCode(channel, chatId) {
    const prefix = channel === CHANNEL_VK ? "v" : "t";
    return `${prefix}${Number(chatId).toString(36)}`;
}

function parseRefCode(refCode) {
    if (!refCode || typeof refCode !== "string" || !/^[tv][0-9a-z]+$/i.test(refCode)) {
        return null;
    }

    const channel = refCode[0].toLowerCase() === "v" ? CHANNEL_VK : CHANNEL_TG;
    const parsed = parseInt(refCode.slice(1), 36);
    if (!Number.isSafeInteger(parsed)) return null;

    return { channel, chatId: parsed };
}

/* -------------------------------------------------------------------------- */
/* shared helpers                                                              */
/* -------------------------------------------------------------------------- */

function parseStartPayload(text) {
    if (!text) return null;
    const parts = text.trim().split(/\s+/);
    if (parts[0].startsWith("/start") && parts[1]) return parts[1];
    return null;
}

function parseSourceAndReferral(payload) {
    if (!payload) return { source: "direct", referred_by: "" };

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

function buildReferralLink(env, session) {
    if (session.channel !== CHANNEL_TG) return "";
    const botUsername = env.BOT_USERNAME || "";
    const refCode = session.ref_code || "";
    if (!botUsername || !refCode) return "";
    return `https://t.me/${botUsername}?start=ref_${refCode}`;
}

function buildAgentChannelLine(env) {
    if (!env.AGENT_CHANNEL_URL) return "";
    return `${AGENT_CHANNEL_TEXT}: ${env.AGENT_CHANNEL_URL}`;
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
    const digits = String(raw).replace(/\D+/g, "");
    let cleaned = digits;

    if (cleaned.length === 10 && cleaned.startsWith("9")) {
        cleaned = `7${cleaned}`;
    }
    if (cleaned.length === 11 && cleaned.startsWith("8")) {
        cleaned = `7${cleaned.slice(1)}`;
    }

    if (cleaned.length !== 11 || !cleaned.startsWith("7")) return null;
    return `+${cleaned}`;
}

function buildOfferText(scenarioText, env, channel = CHANNEL_TG) {
    let stub;
    let pricing;

    if (scenarioText === "Для квартиры или семьи") {
        stub = "Для вашего адреса подходит вариант подключения МТС для квартиры или семьи.";
        pricing =
            "Для вас подключение бесплатно, и первый месяц оплачиваю я.\n" +
            "Со 2 по 4 месяц стоимость составит 475 ₽/мес, далее — 950 ₽/мес.";
    } else if (scenarioText === "Для активного интернета и нескольких устройств") {
        stub = "Для вашего адреса подходит вариант подключения МТС для активного интернета и нескольких устройств.";
        pricing =
            "Для вас подключение бесплатно, и первый месяц оплачиваю я.\n" +
            "Далее стоимость составит 1050 ₽/мес.";
    } else {
        stub = "Для вашего адреса подходит вариант подключения МТС только с интернетом.";
        pricing =
            "Для вас подключение бесплатно, и первый месяц оплачиваю я.\n" +
            "Далее стоимость составит 600 ₽/мес.";
    }

    const channelLine = buildAgentChannelLine(env);
    let text = `${stub}\n${pricing}`;

    if (channelLine) {
        text += `\n${channelLine}`;
    }

    text +=
        "\n\nЕсли удобно, отправьте номер телефона — я свяжусь с вами.\n" +
        `Или можете написать по официальному Telegram-каналу агента МТС, Виктора: ${CONTACT_USERNAME}\n` +
        `Или позвонить по официальному номеру МТС: ${CONTACT_PHONE}\n`;

    if (channel === CHANNEL_VK) {
        text += "\nВ VK номер лучше отправить обычным сообщением в формате +7XXXXXXXXXX.";
    }

    return text;
}

function scenarioFromValue(value) {
    const text = String(value || "").trim();

    if (
        text === "scenario_family" ||
        text === "Для квартиры или семьи" ||
        text === "1" ||
        text === "1. Для квартиры или семьи"
    ) {
        return "Для квартиры или семьи";
    }

    if (
        text === "scenario_active" ||
        text === "Для активного интернета" ||
        text === "Для активного интернета и нескольких устройств" ||
        text === "2" ||
        text === "2. Для активного интернета"
    ) {
        return "Для активного интернета и нескольких устройств";
    }

    if (
        text === "scenario_only" ||
        text === "Нужен только интернет" ||
        text === "3" ||
        text === "3. Нужен только интернет"
    ) {
        return "Нужен только интернет";
    }

    return "";
}

function isShowOptionValue(value) {
    const text = String(value || "").trim();
    return text === "show_option" || text === "Показать вариант и условия" || text === "1";
}

function isContactMeValue(value) {
    const text = String(value || "").trim();
    return text === "contact_me" || text === "Связаться со мной" || text === "2";
}

function isLeavePhoneValue(value) {
    const text = String(value || "").trim();
    return text === "leave_phone" || text === "Оставить номер" || text === "3";
}

function wantsRestart(text) {
    const normalized = String(text || "").trim().toLowerCase();
    return normalized === "/start" || normalized === "начать" || normalized === "start";
}

/* -------------------------------------------------------------------------- */
/* Telegram transport                                                          */
/* -------------------------------------------------------------------------- */

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

async function tgSendMessage(env, chatId, text, extra = {}) {
    return tg(env, "sendMessage", {
        chat_id: chatId,
        text,
        ...extra,
    });
}

async function tgSendPhoto(env, chatId, photo, caption, extra = {}) {
    return tg(env, "sendPhoto", {
        chat_id: chatId,
        photo,
        caption,
        ...extra,
    });
}

async function tgAnswerCallback(env, callbackQueryId) {
    try {
        await tg(env, "answerCallbackQuery", {
            callback_query_id: callbackQueryId,
        });
    } catch (e) {
        console.error("answerCallback error", e);
    }
}

async function tgClearDecisionMessage(env, chatId, messageId) {
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

function buildTelegramPhoneReplyKeyboard(scenarioText) {
    const rows = [
        [{ text: "Отправить номер телефона", request_contact: true }]
    ];

    if (
        scenarioText === "Для квартиры или семьи" ||
        scenarioText === "Для активного интернета и нескольких устройств"
    ) {
        rows.push([{ text: "Что значит группа для близких?" }]);
    }

    rows.push([{ text: "Посмотреть другой тариф" }]);

    return {
        keyboard: rows,
        resize_keyboard: true,
        one_time_keyboard: false,
    };
}

function buildTelegramContactReplyKeyboard() {
    return {
        keyboard: [
            [{ text: "Отправить номер телефона", request_contact: true }],
            [{ text: "Посмотреть другой тариф" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
    };
}

function buildTelegramScenarioMarkup() {
    return {
        inline_keyboard: [
            [{ text: "Для квартиры или семьи", callback_data: "scenario_family" }],
            [{ text: "Для активного интернета", callback_data: "scenario_active" }],
            [{ text: "Нужен только интернет", callback_data: "scenario_only" }],
        ],
    };
}

function buildTelegramDecisionMarkup() {
    return {
        inline_keyboard: [
            [{ text: "Показать вариант и условия", callback_data: "show_option" }],
            [{ text: "Связаться со мной", callback_data: "contact_me" }],
            [{ text: "Оставить номер", callback_data: "leave_phone" }],
        ],
    };
}

function getTelegramTariffPhotoId(env, scenarioText) {
    if (scenarioText === "Для квартиры или семьи") {
        return env.TARIFF_FAMILY_FILE_ID || DEFAULT_TARIFF_FAMILY_FILE_ID;
    }
    if (scenarioText === "Для активного интернета и нескольких устройств") {
        return env.TARIFF_ACTIVE_FILE_ID || DEFAULT_TARIFF_ACTIVE_FILE_ID;
    }
    return env.TARIFF_ONLY_FILE_ID || DEFAULT_TARIFF_ONLY_FILE_ID;
}

function getTelegramGroupClosePhotoId(env) {
    return env.GROUP_CLOSE_FILE_ID || DEFAULT_GROUP_CLOSE_FILE_ID;
}

function getVkGroupCloseAttachment(env) {
    return env.VK_GROUP_CLOSE_ATTACHMENT || "";
}

/* -------------------------------------------------------------------------- */
/* VK transport                                                                */
/* -------------------------------------------------------------------------- */

async function vk(env, method, params = {}) {
    const body = new URLSearchParams();
    body.set("access_token", env.VK_TOKEN || "");
    body.set("v", env.VK_API_VERSION || "5.199");

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        body.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    const res = await fetch(`https://api.vk.com/method/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });

    const data = await res.json();
    if (data.error) {
        console.error("VK API error:", data.error);
        throw new Error(data.error.error_msg || "VK API error");
    }

    return data.response;
}

function makeVkKeyboard(buttonRows, options = {}) {
    return {
        one_time: options && options.one_time || false,
        inline: options && options.inline || false,
        buttons: buttonRows.map((row) =>
            row.map((label) => ({
                action: {
                    type: "text",
                    label,
                    payload: JSON.stringify({ label }),
                },
                color: "primary",
            }))
        ),
    };
}

function buildVkScenarioKeyboard() {
    return makeVkKeyboard(
        [
            ["Для квартиры или семьи"],
            ["Для активного интернета"],
            ["Нужен только интернет"],
        ], { one_time: true }
    );
}

function buildVkDecisionKeyboard() {
    return makeVkKeyboard(
        [
            ["Показать вариант и условия"],
            ["Связаться со мной"],
            ["Оставить номер"]
        ], { one_time: true }
    );
}

function buildVkPhoneKeyboard(scenarioText) {
    const rows = [];

    if (
        scenarioText === "Для квартиры или семьи" ||
        scenarioText === "Для активного интернета и нескольких устройств"
    ) {
        rows.push(["Что значит группа для близких?"]);
    }

    rows.push(["Посмотреть другой тариф"]);
    return makeVkKeyboard(rows, { one_time: false });
}

function buildVkContactKeyboard() {
    return makeVkKeyboard([
        ["Посмотреть другой тариф"]
    ], { one_time: false });
}

function getVkTariffAttachment(env, scenarioText) {
    if (scenarioText === "Для квартиры или семьи") {
        return env.VK_TARIFF_FAMILY_ATTACHMENT || "";
    }
    if (scenarioText === "Для активного интернета и нескольких устройств") {
        return env.VK_TARIFF_ACTIVE_ATTACHMENT || "";
    }
    return env.VK_TARIFF_ONLY_ATTACHMENT || "";
}

async function vkSendMessage(env, peerId, text, extra = {}) {
    const params = {
        peer_id: peerId,
        random_id: randomInt31(),
        message: text,
    };

    if (extra.keyboard) {
        params.keyboard = extra.keyboard;
    }
    if (extra.attachment) {
        params.attachment = extra.attachment;
    }

    return vk(env, "messages.send", params);
}

function randomInt31() {
    return Math.floor(Math.random() * 2147483647);
}

/* -------------------------------------------------------------------------- */
/* outbound router                                                             */
/* -------------------------------------------------------------------------- */

async function sendMessage(env, channel, chatId, text, extra = {}) {
    if (channel === CHANNEL_VK) {
        return vkSendMessage(env, chatId, text, {
            keyboard: extra.keyboard,
            attachment: extra.attachment,
        });
    }

    return tgSendMessage(env, chatId, text, extra);
}

async function sendPhoto(env, channel, chatId, photo, caption, extra = {}) {
    if (channel === CHANNEL_VK) {
        return vkSendMessage(env, chatId, caption, {
            keyboard: extra.keyboard,
            attachment: photo,
        });
    }

    return tgSendPhoto(env, chatId, photo, caption, extra);
}

/* -------------------------------------------------------------------------- */
/* lead helpers                                                                */
/* -------------------------------------------------------------------------- */

async function registerStartLead(env, user, channel, chatId, session) {
    const lead = {
        channel,
        chatId,
        vk_user_id: channel === CHANNEL_VK ? user.id || chatId : "",
        firstName: user && user.firstName || "",
        username: user && user.username || "",
        address: "",
        scenario: "",
        phone: "",
        source: session.source,
        ref_code: session.ref_code || generateRefCode(channel, chatId),
        referred_by: session.referred_by || "",
        referral_reward_status: session.referral_reward_status || "pending",
        status: "started",
        createdAt: new Date().toISOString(),
    };

    const key = `lead:${channel}:${Date.now()}:${chatId}:started`;
    await env.LEADS.put(key, JSON.stringify(lead));
    await notifyAdmin(env, lead);
}

async function registerOfferClickLead(env, user, channel, chatId, session) {
    const lead = {
        channel,
        chatId,
        vk_user_id: channel === CHANNEL_VK ? user.id || chatId : "",
        firstName: user && user.firstName || "",
        username: user && user.username || "",
        address: session.address,
        scenario: session.scenario,
        phone: "",
        source: session.source,
        ref_code: session.ref_code || generateRefCode(channel, chatId),
        referred_by: session.referred_by || "",
        referral_reward_status: session.referral_reward_status || "pending",
        status: "offer_clicked",
        createdAt: new Date().toISOString(),
    };

    const key = `lead:${channel}:${Date.now()}:${chatId}:offer`;
    await env.LEADS.put(key, JSON.stringify(lead));
    await notifyAdmin(env, lead);
}

async function registerReferralLead(env, channel, chatId, session) {
    if (!session.referred_by || session.referral_counted) return;

    const parsed = parseRefCode(session.referred_by);
    if (!parsed) return;

    const referrerSession = await loadSession(env, parsed.channel, parsed.chatId);
    referrerSession.ref_code = referrerSession.ref_code || generateRefCode(parsed.channel, parsed.chatId);
    referrerSession.referrals_count = (referrerSession.referrals_count || 0) + 1;
    await saveSession(env, parsed.channel, parsed.chatId, referrerSession);

    session.referral_counted = true;
    await saveSession(env, channel, chatId, session);
}

async function notifyAdmin(env, lead) {
    if (!env.ADMIN_CHAT_ID) return;

    const text =
        `Новая заявка\n\n` +
        `Канал: ${lead.channel || "-"}\n` +
        `Источник: ${lead.source || "-"}\n` +
        `Referred by: ${lead.referred_by || "-"}\n` +
        `Ref code: ${lead.ref_code || "-"}\n` +
        `Адрес: ${lead.address || "-"}\n` +
        `Сценарий: ${lead.scenario || "-"}\n` +
        `Телефон: ${lead.phone || "-"}\n` +
        `Username: ${lead.username ? "@" + lead.username : "-"}\n` +
        `Chat ID: ${lead.chatId}\n` +
        `VK User ID: ${lead.vk_user_id || "-"}\n` +
        `Статус: ${lead.status || "-"}\n` +
        `Создано: ${lead.createdAt}`;

    try {
        await tgSendMessage(env, env.ADMIN_CHAT_ID, text);
    } catch (e) {
        console.error("Admin notify error", e);
    }
}

async function sendReferralMessage(env, channel, chatId, session) {
    const refCode = session.ref_code || generateRefCode(channel, chatId);
    const refLink = buildReferralLink(env, session);

    let text =
        `Если порекомендуете меня знакомому и он подключится, переведу вам ${REFERRAL_REWARD_TEXT}.\n` +
        `Ваш код рекомендации: ${refCode}`;

    if (refLink) {
        text += `\nВаша ссылка: ${refLink}`;
    }

    text += "\nЕсли знакомому удобнее сразу позвонить, пусть скажет ваш код рекомендации.";

    await sendMessage(env, channel, chatId, text);
}

async function finalizeLead(env, inbound, session, status = STEP_DONE) {
    const { channel, chatId } = inbound;

    const lead = {
        channel,
        chatId,
        vk_user_id: channel === CHANNEL_VK ? inbound.user.id : "",
        firstName: inbound.user.firstName || "",
        username: inbound.user.username || "",
        address: session.address,
        scenario: session.scenario,
        phone: session.phone,
        source: session.source,
        ref_code: session.ref_code || generateRefCode(channel, chatId),
        referred_by: session.referred_by || "",
        referral_reward_status: session.referral_reward_status || "pending",
        status,
        createdAt: new Date().toISOString(),
    };

    const key = `lead:${channel}:${Date.now()}:${chatId}`;
    await env.LEADS.put(key, JSON.stringify(lead));
    await notifyAdmin(env, lead);
    await registerReferralLead(env, channel, chatId, session);

    const extra = channel === CHANNEL_TG ? { reply_markup: { remove_keyboard: true } } : {};

    await sendMessage(
        env,
        channel,
        chatId,
        "Спасибо! Я свяжусь с вами и помогу с подключением.\n" +
        `Если удобнее, можете написать по официальному Telegram-каналу агента МТС, Виктора: ${CONTACT_USERNAME}\n` +
        `Или позвонить по официальному номеру МТС: ${CONTACT_PHONE}`,
        extra
    );

    await sendReferralMessage(env, channel, chatId, session);
}

/* -------------------------------------------------------------------------- */
/* shared flow                                                                 */
/* -------------------------------------------------------------------------- */

function makeInbound({ channel, chatId, text = "", user = {}, contactPhone = "", meta = {} }) {
    return {
        channel,
        chatId,
        text: String(text || "").trim(),
        contactPhone: contactPhone || "",
        user: {
            firstName: user.firstName || "",
            username: user.username || "",
            id: user.id || "",
        },
        meta,
    };
}

async function sendScenarioButtons(env, channel, chatId) {
    if (channel === CHANNEL_VK) {
        await sendMessage(env, channel, chatId, "Спасибо. Теперь выберите, что вам нужно:", {
            keyboard: buildVkScenarioKeyboard(),
        });
        return;
    }

    await sendMessage(env, channel, chatId, "Спасибо. Теперь выберите, что вам нужно:", {
        reply_markup: buildTelegramScenarioMarkup(),
    });
}

async function sendDecision(env, channel, chatId) {
    if (channel === CHANNEL_VK) {
        await sendMessage(
            env,
            channel,
            chatId,
            "По вашему адресу есть подходящий вариант подключения МТС.\nЯ могу коротко показать условия и мой личный бонус при подключении.", {
                keyboard: buildVkDecisionKeyboard(),
            }
        );
        return;
    }

    await sendMessage(
        env,
        channel,
        chatId,
        "По вашему адресу есть подходящий вариант подключения МТС.\n" +
        "Я могу коротко показать условия и мой личный бонус при подключении.", {
            reply_markup: buildTelegramDecisionMarkup(),
        }
    );
}

async function sendShowOptionAndPhoneRequest(env, channel, chatId, scenarioText) {
    const text = buildOfferText(scenarioText, env, channel);

    if (channel === CHANNEL_VK) {
        const attachment = getVkTariffAttachment(env, scenarioText);
        await sendMessage(env, channel, chatId, text, {
            keyboard: buildVkPhoneKeyboard(scenarioText),
            attachment,
        });
        return;
    }

    const photoId = getTelegramTariffPhotoId(env, scenarioText);
    const replyMarkup = buildTelegramPhoneReplyKeyboard(scenarioText);

    if (photoId) {
        await sendPhoto(env, channel, chatId, photoId, text, {
            reply_markup: replyMarkup,
        });
        return;
    }

    await sendMessage(env, channel, chatId, text, {
        reply_markup: replyMarkup,
    });
}

async function handleCommonInbound(inbound, env) {
    const { channel, chatId, text, contactPhone } = inbound;
    const session = await loadSession(env, channel, chatId);
    session.channel = channel;

    if (contactPhone && session.step === STEP_WAITING_PHONE) {
        const normalized = normalizePhone(contactPhone);
        if (!normalized) {
            if (channel === CHANNEL_VK) {
                await sendMessage(
                    env,
                    channel,
                    chatId,
                    "Нужен номер в формате +7XXXXXXXXXX. Напишите его обычным сообщением.", { keyboard: buildVkPhoneKeyboard(session.scenario) }
                );
            } else {
                await sendMessage(
                    env,
                    channel,
                    chatId,
                    "Нужен номер в формате +7XXXXXXXXXX. Или отправьте контакт кнопкой ниже.", { reply_markup: buildTelegramPhoneReplyKeyboard(session.scenario) }
                );
            }
            return;
        }

        session.phone = normalized;
        session.step = STEP_DONE;
        await saveSession(env, channel, chatId, session);
        await finalizeLead(env, inbound, session, STEP_DONE);
        return;
    }

    const normalizedText = text.trim().toLowerCase();

    if (
        text.startsWith("/start") ||
        normalizedText === "начать" ||
        normalizedText === "start"
    ) {
        const payload = parseStartPayload(text);
        const { source, referred_by } = parseSourceAndReferral(payload);

        session.source = source || "direct";
        session.referred_by = referred_by || "";
        session.ref_code = session.ref_code || generateRefCode(channel, chatId);

        if (session.ref_code && session.referred_by && session.ref_code === session.referred_by) {
            session.referred_by = "";
        }

        session.step = STEP_WAITING_ADDRESS;
        session.address = "";
        session.scenario = "";
        session.phone = "";

        await saveSession(env, channel, chatId, session);
        await sendMessage(
            env,
            channel,
            chatId,
            "Здравствуйте!\nЧтобы проверить интернет по вашему адресу, напишите улицу и номер дома — это займет меньше минуты."
        );

        await registerStartLead(env, inbound.user, channel, chatId, session);
        return;
    }

    if (text === "/contact") {
        await sendMessage(
            env,
            channel,
            chatId,
            `Напишите мне напрямую: ${CONTACT_USERNAME}\nИли позвоните: ${CONTACT_PHONE}`
        );
        return;
    }

    if (text === "/skip" && session.step === STEP_WAITING_PHONE) {
        session.phone = "";
        session.step = STEP_DONE_WITHOUT_PHONE;
        await saveSession(env, channel, chatId, session);
        await finalizeLead(env, inbound, session, STEP_DONE_WITHOUT_PHONE);
        return;
    }

    if (text === "Посмотреть другой тариф" && session.step === STEP_WAITING_PHONE) {
        session.step = STEP_WAITING_SCENARIO;
        await saveSession(env, channel, chatId, session);
        await sendScenarioButtons(env, channel, chatId);
        return;
    }

    if (
        text === "Что значит группа для близких?" &&
        session.step === STEP_WAITING_PHONE &&
        (
            session.scenario === "Для квартиры или семьи" ||
            session.scenario === "Для активного интернета и нескольких устройств"
        )
    ) {
        const helpText =
            "Группа для близких — это возможность объединить близких в один удобный сценарий пользования связью.\n" +
            "Посмотрите пример на изображении ниже.\n\n" +
            "Если удобно, после этого отправьте номер телефона — я свяжусь с вами и всё объясню.";

        if (channel === CHANNEL_VK) {
            const attachment = getVkGroupCloseAttachment(env);

            if (attachment) {
                await sendPhoto(env, channel, chatId, attachment, helpText, {
                    keyboard: buildVkPhoneKeyboard(session.scenario),
                });
            } else {
                await sendMessage(env, channel, chatId, helpText, {
                    keyboard: buildVkPhoneKeyboard(session.scenario),
                });
            }
        } else {
            const photoId = getTelegramGroupClosePhotoId(env);

            if (photoId) {
                await sendPhoto(env, channel, chatId, photoId, helpText, {
                    reply_markup: buildTelegramPhoneReplyKeyboard(session.scenario),
                });
            } else {
                await sendMessage(env, channel, chatId, helpText, {
                    reply_markup: buildTelegramPhoneReplyKeyboard(session.scenario),
                });
            }
        }

        return;
    }
    if (session.step === STEP_WAITING_ADDRESS) {
        if (!isValidAddress(text)) {
            await sendMessage(env, channel, chatId, "Пожалуйста, напишите улицу и номер дома, например: Советская 120.");
            return;
        }

        session.address = text.trim();
        session.step = STEP_WAITING_SCENARIO;
        await saveSession(env, channel, chatId, session);
        await sendScenarioButtons(env, channel, chatId);
        return;
    }

    if (session.step === STEP_WAITING_SCENARIO) {
        const scenario = scenarioFromValue(text);
        if (!scenario) {
            if (channel === CHANNEL_VK) {
                await sendMessage(
                    env,
                    channel,
                    chatId,
                    "Выберите вариант кнопкой ниже или напишите 1, 2 или 3.", { keyboard: buildVkScenarioKeyboard() }
                );
            } else {
                await sendMessage(env, channel, chatId, "Выберите вариант кнопкой ниже.");
            }
            return;
        }

        session.scenario = scenario;
        session.step = STEP_WAITING_DECISION;
        await saveSession(env, channel, chatId, session);
        await sendDecision(env, channel, chatId);
        return;
    }

    if (session.step === STEP_WAITING_DECISION) {
        if (isShowOptionValue(text)) {
            session.step = STEP_WAITING_PHONE;
            await saveSession(env, channel, chatId, session);
            await registerOfferClickLead(env, inbound.user, channel, chatId, session);
            await sendShowOptionAndPhoneRequest(env, channel, chatId, session.scenario);
            return;
        }

        if (isContactMeValue(text)) {
            session.step = STEP_WAITING_PHONE;
            await saveSession(env, channel, chatId, session);
            await registerOfferClickLead(env, inbound.user, channel, chatId, session);

            const channelLine = buildAgentChannelLine(env);
            let reply =
                `Можете написать по официальному Telegram-каналу агента МТС, Виктора: ${CONTACT_USERNAME}\n` +
                `Или позвонить по официальному номеру МТС: ${CONTACT_PHONE}\n` +
                "Подключение бесплатно для вас, первый месяц я оплачиваю сам.\n" +
                "Если удобнее, отправьте номер телефона — я сам свяжусь с вами.";

            if (channelLine) {
                reply += `\n${channelLine}`;
            }

            if (channel === CHANNEL_VK) {
                reply += "\nНомер в VK лучше отправить обычным сообщением в формате +7XXXXXXXXXX.";
                await sendMessage(env, channel, chatId, reply, {
                    keyboard: buildVkContactKeyboard(),
                });
            } else {
                await sendMessage(env, channel, chatId, reply, {
                    reply_markup: buildTelegramContactReplyKeyboard(),
                });
            }
            return;
        }

        if (isLeavePhoneValue(text)) {
            session.step = STEP_WAITING_PHONE;
            await saveSession(env, channel, chatId, session);
            await registerOfferClickLead(env, inbound.user, channel, chatId, session);

            const reply =
                "Если удобно, отправьте номер телефона — я свяжусь с вами.\n" +
                `Или можете написать по официальному Telegram-каналу агента МТС, Виктора: ${CONTACT_USERNAME}\n` +
                `Или позвонить по официальному номеру МТС: ${CONTACT_PHONE}\n`;

            if (channel === CHANNEL_VK) {
                await sendMessage(
                    env,
                    channel,
                    chatId,
                    `${reply}\nВ VK номер лучше отправить обычным сообщением в формате +7XXXXXXXXXX.`, {
                        keyboard: buildVkPhoneKeyboard(session.scenario),
                    }
                );
            } else {
                await sendMessage(env, channel, chatId, reply, {
                    reply_markup: buildTelegramPhoneReplyKeyboard(session.scenario),
                });
            }
            return;
        }

        if (channel === CHANNEL_VK) {
            await sendMessage(
                env,
                channel,
                chatId,
                "Выберите один из вариантов кнопкой ниже или напишите 1, 2 или 3.", { keyboard: buildVkDecisionKeyboard() }
            );
            return;
        }

        await sendMessage(env, channel, chatId, "Если хотите начать заново, отправьте /start.");
        return;
    }

    if (session.step === STEP_WAITING_PHONE) {
        const normalized = normalizePhone(text);
        if (!normalized) {
            if (channel === CHANNEL_VK) {
                await sendMessage(
                    env,
                    channel,
                    chatId,
                    "Нужен номер в формате +7XXXXXXXXXX. Напишите его обычным сообщением.", { keyboard: buildVkPhoneKeyboard(session.scenario) }
                );
            } else {
                await sendMessage(
                    env,
                    channel,
                    chatId,
                    "Нужен номер в формате +7XXXXXXXXXX. Или отправьте контакт кнопкой ниже.", { reply_markup: buildTelegramPhoneReplyKeyboard(session.scenario) }
                );
            }
            return;
        }

        session.phone = normalized;
        session.step = STEP_DONE;
        await saveSession(env, channel, chatId, session);
        await finalizeLead(env, inbound, session, STEP_DONE);
        return;
    }

    if (session.step === STEP_DONE || session.step === STEP_DONE_WITHOUT_PHONE) {
        await sendMessage(
            env,
            channel,
            chatId,
            `Если хотите начать заново, отправьте /start.\nЕсли удобнее, напишите мне напрямую: ${CONTACT_USERNAME}`
        );
        return;
    }

    if (wantsRestart(text)) {
        await sendMessage(env, channel, chatId, "Напишите /start, чтобы начать заново.");
        return;
    }

    await sendMessage(env, channel, chatId, "Напишите /start, чтобы начать заново.");
}

/* -------------------------------------------------------------------------- */
/* Telegram handlers                                                           */
/* -------------------------------------------------------------------------- */

async function handleTelegramUpdate(update, env) {
    if (update.message) {
        const msg = update.message;
        const inbound = makeInbound({
            channel: CHANNEL_TG,
            chatId: msg.chat.id,
            text: msg.text || "",
            contactPhone: (msg.contact && msg.contact.phone_number) || "",
            user: {
                id: (msg.from && msg.from.id) || "",
                firstName: (msg.from && msg.from.first_name) || (msg.chat && msg.chat.first_name) || "",
                username: (msg.from && msg.from.username) || (msg.chat && msg.chat.username) || "",
            },
            meta: { telegramMessage: msg },
        });

        const session = await loadSession(env, CHANNEL_TG, inbound.chatId);

        if (msg.contact && session.step === STEP_WAITING_PHONE) {
            if (msg.contact.user_id && msg.from && msg.contact.user_id !== msg.from.id) {
                await sendMessage(
                    env,
                    CHANNEL_TG,
                    inbound.chatId,
                    "Контакт должен быть вашим. Отправьте свой номер или введите его вручную.", { reply_markup: buildTelegramPhoneReplyKeyboard(session.scenario) }
                );
                return;
            }
        }

        await handleCommonInbound(inbound, env);
        return;
    }

    if (update.callback_query) {
        await handleTelegramCallback(update.callback_query, env);
    }
}

async function handleTelegramCallback(cb, env) {
    const chatId = cb.message.chat.id;
    const data = cb.data;
    const session = await loadSession(env, CHANNEL_TG, chatId);

    await tgAnswerCallback(env, cb.id);

    if (String(data || "").startsWith("scenario_")) {
        if (session.step !== STEP_WAITING_SCENARIO) {
            await sendMessage(env, CHANNEL_TG, chatId, "Если хотите начать заново, отправьте /start.");
            return;
        }

        const scenario = scenarioFromValue(data);
        if (!scenario) {
            await sendMessage(env, CHANNEL_TG, chatId, "Если хотите начать заново, отправьте /start.");
            return;
        }

        session.scenario = scenario;
        session.step = STEP_WAITING_DECISION;
        await saveSession(env, CHANNEL_TG, chatId, session);

        await tgClearDecisionMessage(env, chatId, cb.message.message_id);
        await sendDecision(env, CHANNEL_TG, chatId);
        return;
    }

    if (["show_option", "contact_me", "leave_phone"].includes(String(data || ""))) {
        if (session.step !== STEP_WAITING_DECISION) {
            await sendMessage(env, CHANNEL_TG, chatId, "Если хотите начать заново, отправьте /start.");
            return;
        }

        const inbound = makeInbound({
            channel: CHANNEL_TG,
            chatId,
            text: data,
            user: {
                id: (cb.from && cb.from.id) || "",
                firstName: (cb.from && cb.from.first_name) || "",
                username: (cb.from && cb.from.username) || "",
            },
        });

        await tgClearDecisionMessage(env, chatId, cb.message.message_id);
        await handleCommonInbound(inbound, env);
    }
}

/* -------------------------------------------------------------------------- */
/* VK handlers                                                                 */
/* -------------------------------------------------------------------------- */

async function handleVkUpdate(update, env) {
    if (String(update.type || "") !== "message_new") {
        return;
    }

    const object = update.object || {};
    const message = object.message || object;

    if (!message) return;
    if (Number(message.out) === 1) return;

    const inbound = makeInbound({
        channel: CHANNEL_VK,
        chatId: message.peer_id || message.user_id || message.from_id,
        text: message.text || "",
        user: {
            id: message.from_id || message.user_id || "",
            firstName: "",
            username: "",
        },
        meta: { vkMessage: message },
    });

    await handleCommonInbound(inbound, env);
}