/**
 * photo-store-worker.js
 *
 * Временная заглушка для Cloudflare Worker:
 * - сохраняет 4 картинки в Telegram -> получает file_id
 * - сохраняет 4 картинки в VK -> получает attachment вида photo...
 * - возвращает JSON с готовыми значениями
 *
 * Нужные env:
 * - WEBHOOK_SECRET
 * - BOT_TOKEN                  // Telegram bot token
 * - TG_CHAT_ID                 // chat_id, куда бот может прислать фото
 * - VK_TOKEN
 * - VK_API_VERSION             // например 5.199
 *
 * - PHOTO_FAMILY_URL
 * - PHOTO_ACTIVE_URL
 * - PHOTO_ONLY_URL
 * - PHOTO_GROUP_CLOSE_URL
 *
 * Запуск:
 * GET https://<worker-domain>/store-photos/<WEBHOOK_SECRET>
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/") {
            return json({
                ok: true,
                message: "Use /store-photos/<WEBHOOK_SECRET>",
            });
        }

        const expectedPath = `/store-photos/${env.WEBHOOK_SECRET}`;
        if (request.method === "GET" && url.pathname === expectedPath) {
            try {
                const result = await storePhotos(env);
                return json({
                    ok: true,
                    result,
                });
            } catch (error) {
                return json({
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    },
                    500
                );
            }
        }

        return new Response("not found", { status: 404 });
    },
};

async function storePhotos(env) {
    assertEnv(env, [
        "WEBHOOK_SECRET",
        "BOT_TOKEN",
        "VK_TOKEN",
        "PHOTO_FAMILY_URL",
        "PHOTO_ACTIVE_URL",
        "PHOTO_ONLY_URL",
        "PHOTO_GROUP_CLOSE_URL",
    ]);

    const files = [{
            key: "family",
            url: env.PHOTO_FAMILY_URL,
            tgEnv: "TARIFF_FAMILY_FILE_ID",
            vkEnv: "VK_TARIFF_FAMILY_ATTACHMENT",
        },
        {
            key: "active",
            url: env.PHOTO_ACTIVE_URL,
            tgEnv: "TARIFF_ACTIVE_FILE_ID",
            vkEnv: "VK_TARIFF_ACTIVE_ATTACHMENT",
        },
        {
            key: "only",
            url: env.PHOTO_ONLY_URL,
            tgEnv: "TARIFF_ONLY_FILE_ID",
            vkEnv: "VK_TARIFF_ONLY_ATTACHMENT",
        },
        {
            key: "group_close",
            url: env.PHOTO_GROUP_CLOSE_URL,
            tgEnv: "GROUP_CLOSE_FILE_ID",
            vkEnv: "VK_GROUP_CLOSE_ATTACHMENT",
        },
    ];

    const output = {};

    for (const file of files) {
        const image = await fetchImage(file.url);

        const [tgFileId, vkAttachment] = await Promise.all([
            tgStorePhoto(env, image, file.key),
            vkStorePhoto(env, image, file.key),
        ]);

        output[file.key] = {
            source_url: file.url,
            [file.tgEnv]: tgFileId,
            [file.vkEnv]: vkAttachment,
        };
    }

    const envReady = {};
    for (const file of files) {
        envReady[file.tgEnv] = output[file.key][file.tgEnv];
        envReady[file.vkEnv] = output[file.key][file.vkEnv];
    }

    return {
        copy_to_env: envReady,
        raw: output,
    };
}

async function fetchImage(imageUrl) {
    const res = await fetch(imageUrl);

    if (!res.ok) {
        throw new Error(`Failed to download image: ${imageUrl} (${res.status})`);
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await res.arrayBuffer();

    return {
        bytes: arrayBuffer,
        contentType,
        fileName: guessFileName(imageUrl, contentType),
    };
}

function guessFileName(imageUrl, contentType) {
    try {
        const url = new URL(imageUrl);
        const pathname = url.pathname || "";
        const last = pathname.split("/").filter(Boolean).pop();
        if (last && last.includes(".")) return last;
    } catch {}

    if (contentType.includes("png")) return "image.png";
    if (contentType.includes("webp")) return "image.webp";
    return "image.jpg";
}

async function tgStorePhoto(env, image, key) {
    const form = new FormData();
    form.set("chat_id", String("1252859891"));
    form.set("caption", `store:${key}`);
    form.set("photo", new Blob([image.bytes], { type: image.contentType }), image.fileName);

    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        body: form,
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
        throw new Error(`Telegram sendPhoto failed for ${key}: ${JSON.stringify(data)}`);
    }

    const sizes = (data && data.result && data.result.photo) || [];
    if (!sizes.length) {
        throw new Error(`Telegram returned no photo sizes for ${key}`);
    }

    return sizes[sizes.length - 1].file_id;
}

async function vkStorePhoto(env, image, key) {
    const uploadServer = await vkApi(env, "photos.getMessagesUploadServer", {});

    if (!(uploadServer && uploadServer.upload_url)) {
        throw new Error(`VK upload_url not found for ${key}`);
    }

    const form = new FormData();
    form.set("photo", new Blob([image.bytes], { type: image.contentType }), image.fileName);

    const uploadRes = await fetch(uploadServer.upload_url, {
        method: "POST",
        body: form,
    });

    const uploadData = await uploadRes.json();

    if (!uploadRes.ok || !uploadData.server || !uploadData.photo || !uploadData.hash) {
        throw new Error(`VK upload failed for ${key}: ${JSON.stringify(uploadData)}`);
    }

    const saved = await vkApi(env, "photos.saveMessagesPhoto", {
        server: uploadData.server,
        photo: uploadData.photo,
        hash: uploadData.hash,
    });

    const photo = Array.isArray(saved) ? saved[0] : null;
    if (!(photo && photo.owner_id) || !(photo && photo.id)) {
        throw new Error(`VK saveMessagesPhoto failed for ${key}: ${JSON.stringify(saved)}`);
    }

    return `photo${photo.owner_id}_${photo.id}`;
}

async function vkApi(env, method, params) {
    const apiVersion = env.VK_API_VERSION || "5.199";

    const url = new URL(`https://api.vk.ru/method/${method}`);
    url.searchParams.set("access_token", env.VK_TOKEN);
    url.searchParams.set("v", apiVersion);

    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
        if (v !== undefined && v !== null) {
            body.set(k, String(v));
        }
    }

    const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    const data = await res.json();

    if (!res.ok || data.error) {
        throw new Error(`VK API ${method} failed: ${JSON.stringify(data)}`);
    }

    return data.response;
}

function assertEnv(env, keys) {
    for (const key of keys) {
        if (!env[key]) {
            throw new Error(`Missing env: ${key}`);
        }
    }
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
        },
    });
}