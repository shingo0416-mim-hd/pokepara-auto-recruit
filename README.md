# Playwright

## Env
Node >= 18

## Installation
```
npm init playwright@latest
npx playwright install
```
https://playwright.dev/docs/intro

## Chatwork
```
node tests/scripts/runTests.ts baitoru
```

## Run
```
npx playwright test tests/recruit.spec.ts --project="Google Chrome" --debug 
npx playwright test tests/recruit.spec.ts --project="Mobile Safari" --debug
```
## .env
### Database (PostgreSQL)
```
DB_URL=postgres://user:pass@host:5432/your_database
BAITORU_TENANT_ID=1
```
Baitoruのログイン情報はbaitoru_credentialsテーブル（is_primary=true）から取得するため、BAITORU_LOGIN_ID/BAITORU_LOGIN_PASSは不要です。
Emailの接続情報はmail_settingsテーブルのreply_email/gmail_app_keyを使用し、件名・本文もmail_settings.subject/contentをプレースホルダ($COMPANY/$NAME/$JOBNO/$JOBNAME/$ADDRESS/$CONTACT/$TEL)置換して送信します。
※ mail_settings.subject/content が未設定の場合はメール送信をスキップします。
※ $JOBNO は画面上の「仕事No」、$JOBNAME は「業務名」、$ADDRESS は「勤務先住所」、$CONTACT は「応募受付先」欄の名称、$TEL はそのTEL番号を差し込みます。
Chatworkの通知設定はchatwork_settingsテーブルのis_active/api_token/room_idを使用するため、CHATWORK_*系の環境変数は不要です。
SMS/RCSはsms_settingsテーブルのis_active/api_token/api_client_id/api_chatbot_id/api_type/api_template_id(use_template)およびsms_text/rcs_textを使用し、プレースホルダ($COMPANY/$NAME/$JOBNO/$JOBNAME/$ADDRESS/$CONTACT/$TEL)を置換して送信します（AIX richrcs API: https://richrcs-api.serv.aixmsg.com）。環境変数SEND_SMSやTwilio設定は不要です。
### recruit-nomi-hub 連携
```
RECRUIT_PROSPECTS_API_BASE_URL=https://recruit.nomihub.jp
RECRUIT_PROSPECTS_API_TOKEN=your-shared-token
RECRUIT_PROSPECTS_API_TIMEOUT_MS=15000
```
メール/SMS送信成功時に `POST /api/recruit/prospects/message-events` を呼び、電話番号・メールアドレス・仕事No・送信履歴を recruit-nomi-hub 側へ蓄積します。
### メール送信制御フラグ
```
# メール受信そのものをスキップ
SKIP_EMAIL=false

# Gmailへの下書き保存だけを抑止（ローカル下書きは出力されます）
SKIP_MAIL_DRAFT=true

# Draftsフォルダが既定値と異なる場合に指定（例: [Gmail]/下書き）
GMAIL_DRAFTS_MAILBOX=
```

```
Inside that directory, you can run several commands:

  npx playwright test
    Runs the end-to-end tests.

  npx playwright test --ui
    Starts the interactive UI mode.

  npx playwright test --project=chromium
    Runs the tests only on Desktop Chrome.

  npx playwright test example
    Runs the tests in a specific file.

  npx playwright test --debug
    Runs the tests in debug mode.

  npx playwright codegen
    Auto generate tests with Codegen.

We suggest that you begin by typing:

    npx playwright test

And check out the following files:
  - ./tests/example.spec.js - Example end-to-end test
  - ./tests-examples/demo-todo-app.spec.js - Demo Todo App end-to-end tests
  - ./playwright.config.js - Playwright Test configuration
```
