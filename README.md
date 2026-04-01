# Telegram бот на Cloudflare Workers (бесплатно, без «засыпания»)

Что получаем: бот на webhook, хранит сессии и лиды в Workers KV, работает на фритире (100k запросов/день). Дисков нет, но KV сохраняет данные.

## Шаги
1) Создай бота в @BotFather  
   - `/newbot` → токен.  
   - `/setprivacy` → Disable (чтобы бот видел контакты).  
   - Запиши токен.

2) Установи wrangler (CLI Cloudflare)  
```bash
npm install -g wrangler
wrangler login
```

3) Создай KV namespaces (новый синтаксис Wrangler)  
```bash
wrangler kv namespace create SESSIONS
wrangler kv namespace create LEADS
```
Скопируй `id` из вывода (binding нам нужен `id`, не preview_id).

4) Скопируй шаблон конфигурации  
```bash
cd cf-worker
copy wrangler.template.toml wrangler.toml   # или cp в bash
```
В `wrangler.toml` подставь свои `id` у SESSIONS и LEADS.

5) Добавь секреты (не кладём в файл)  
```bash
wrangler secret put BOT_TOKEN
wrangler secret put WEBHOOK_SECRET   # придумай рандомную строку, напр. 24 символа
# (опционально) чтобы получать уведомления о лидах:
# wrangler secret put ADMIN_CHAT_ID
```

6) Задеплой Worker  
```bash
wrangler deploy
```
В выводе увидишь `https://<name>.<subdomain>.workers.dev`.

7) Настрой webhook в Telegram  
Подставь свой URL и секрет:  
```bash
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=https://<name>.<subdomain>.workers.dev/webhook/$WEBHOOK_SECRET"
```
Проверь статус:  
```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

8) Протестируй  
- В Telegram нажми `/start`, пройди сценарий, отправь телефон.  
- В KV запись появится с ключом `lead:<timestamp>:<chatId>`. Посмотреть:  
```bash
wrangler kv:key list --namespace-id <LEADS_ID> | head
wrangler kv:key get --namespace-id <LEADS_ID> "lead:...:..."
```

9) Кастомизируй контакт  
В `worker.js` замени `@YOUR_USERNAME` на свой @username (два вхождения).

## Быстрые команды wrangler
- Просмотр логов: `wrangler tail`
- Редеплой после правок: `wrangler deploy`

Готово: бот работает бесплатно, не засыпает, данные лежат в KV.
