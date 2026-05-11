# Воронка и ТЗ для бота (листовка → Telegram, MVP)

## Краткий вывод (что делаем)
- Листовка ведёт холодный трафик в Telegram по QR с `start`-payload.
- Бот — короткая цепочка: приветствие → адрес → сценарий → подтверждение «есть вариант» → выбор (показать/связаться/номер) → сбор номера → спасибо.
- Тон: спокойный, без бренда на входе, без агрессии и «бонусов в лоб».
- Храним минимум: source, address, scenario, phone, username, created_at, status.
- Уведомляем себя о новой заявке в личку (ADMIN_CHAT_ID) + сохраняем в KV.

## Финальный сценарий (тексты и кнопки)
Шаг 0 `/start` (payload=`source`):
- Текст: «Здравствуйте! Чтобы проверить интернет по вашему адресу, напишите улицу и номер дома — это займет меньше минуты.»
- Статус → `waiting_address`.

Шаг 1 адрес:
- Сохраняем `address`, статус → `waiting_scenario`.
- Сообщение: «Спасибо. Теперь выберите, что вам нужно:»
- Inline-кнопки: `Для квартиры или семьи` → scenario_family; `Для активного интернета и нескольких устройств` → scenario_active; `Нужен только интернет` → scenario_only.

Шаг 2 сценарий:
- Сохраняем `scenario`, статус → `waiting_decision`.
- Сообщение: «По вашему адресу есть подходящий вариант подключения. Хотите посмотреть, что подойдёт, или связаться со мной?»
- Inline-кнопки: `Показать вариант` → show_option; `Связаться со мной` → contact_me; `Оставить номер` → leave_phone.

Шаг 3 (decision):
- При show_option показываем stub по сценарию (см. уточнения) и переходим к запросу телефона.
- При contact_me/leave_phone сразу к запросу телефона.
- Запрос телефона (reply keyboard с request_contact): «Отправьте номер телефона, и я свяжусь с вами. Если не хотите оставлять номер, можете написать мне напрямую: @YOUR_USERNAME. Если номер не нужен — отправьте /skip.» Статус → `waiting_phone`.

Шаг 4 телефон:
- При contact.phone → нормализуем, сохраняем, статус `done`.
- При текстовом номере → нормализуем (формат +7XXXXXXXXXX). Если невалидно — просим повторить.
- При `/skip` → статус `done_without_phone` (для аналитики), без телефона.
- Сообщение «Спасибо! Я свяжусь с вами... Если удобнее, можете написать мне: @YOUR_USERNAME»
- Лид пишется в KV, уведомление админу.

Fallback:
- Любой ввод в `done`/`done_without_phone` → «Если хотите начать заново, отправьте /start. Если удобнее, напишите мне напрямую: @YOUR_USERNAME»
- `/contact` в любое время → «Напишите мне напрямую: @YOUR_USERNAME»

## Уточнения к реализации (важно)
1. Любой `/start` сбрасывает сессию, `source` читается заново; если payload нет — `source = "direct"`.
2. `show_option` не показывает тарифы, только stub по сценарию:  
   - family → «Для вашего адреса подходит вариант для квартиры или семьи.»  
   - active → «Для вашего адреса подходит вариант для активного интернета и нескольких устройств.»  
   - only → «Для вашего адреса подходит вариант только с интернетом.»  
   Затем просьба оставить номер или написать напрямую.
3. Телефон: ReplyKeyboardMarkup с `request_contact`; URL-кнопки в той же клавиатуре не ставим. Ссылку на @USERNAME даём текстом.
4. Если номер не хотят давать — команда `/skip` фиксирует `done_without_phone` + выводит контакт.
5. Нормализация телефона → `+7XXXXXXXXXX`:  
   - удалить пробелы/скобки/дефисы;  
   - `8XXXXXXXXXX` → `+7XXXXXXXXXX`;  
   - `7XXXXXXXXXX` → `+7XXXXXXXXXX`;  
   - `9XXXXXXXXX` (10 цифр, начинается с 9) → `+7` + цифры;  
   - иначе ошибка.
6. Уведомление админу (фиксированный шаблон):  
   ```
   Новая заявка

   Источник: <source>
   Адрес: <address>
   Сценарий: <scenario>
   Телефон: <phone>
   Username: @<username>
   Chat ID: <chatId>
   Статус: <status>
   Создано: <iso>
   ```
7. Если пользователь завершил и пишет не `/start` — отвечаем коротко: «Если хотите начать заново, отправьте /start. Если удобнее, напишите мне напрямую: @YOUR_USERNAME»

## Данные (сессия / лид)
- source (start-payload или "direct")
- address
- scenario ∈ {family, active, only}
- phone
- tg_username
- tg_chat_id
- created_at (ISO)
- status ∈ {start, waiting_address, waiting_scenario, waiting_decision, waiting_phone, done, done_without_phone}

## Техническое ТЗ (Cloudflare Workers + KV)
- Стек: Cloudflare Workers (webhook) + Telegram Bot API + KV (sessions/leads).
- Файлы: `worker.js` (entry), `messages.js` (необязательно), `services/*` (опционально), `wrangler.toml`, `README.md`.
- ENV/Secrets: `BOT_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_CHAT_ID` (optional).
- KV: `SESSIONS` (TTL 7d, key=chatId), `LEADS` (key=lead:<ts>:<chatId>).
- State machine: хранится в KV; ключ chatId.
- Admin notify: при статусах `done`/`done_without_phone` шлём сообщение в ADMIN_CHAT_ID.
- Логирование: лиды в KV, tail для отладки.
- A/B: `source` из payload (`/start flyerA` и т.п.).

## Структура (предложение)
```
cf-worker/
  worker.js
  README.md
  wrangler.toml
  services/ (опц.)
  messages.js (опц.)
```

## Псевдокод коротко
```
on /start: reset session, source=payload||direct, -> waiting_address
waiting_address: save address -> waiting_scenario + scenario buttons
callback scenario_*: save scenario -> waiting_decision + decision buttons
callback show_option/contact_me/leave_phone: send stub (если show), -> waiting_phone + contact keyboard
waiting_phone: contact -> done; text phone normalize -> done; /skip -> done_without_phone; else ask again
finalize: save lead (status), notify admin, thank you, remove keyboard
fallback done/*: prompt /start + contact link
```
