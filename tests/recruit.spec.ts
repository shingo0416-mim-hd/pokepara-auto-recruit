import { test } from '@playwright/test';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  buildRecruitEmailDraft,
  saveRecruitEmailDraftToGmail,
  sendRecruitEmail,
  setMailCredentials,
} from './helpers/mail';
import { sendAixMessage } from './helpers/sms';
import { notifyEmailResult, notifySmsResult, setChatworkConfig } from './helpers/chatwork';
import { fetchChatworkSettings, fetchMailSettings, fetchPrimaryBaitoruCredentials, fetchSmsSettings, fetchStoreBroadcastConditions, resolveTenantId } from './helpers/db';
import { notifyRecruitProspectMessageEvent } from './helpers/recruitProspects';

dotenv.config();

/**
 * スクリーンショット用のディレクトリを作成
 */
const screenshotDir = "screenshots/recruit";
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log(`スクリーンショットディレクトリを作成しました: ${screenshotDir}`);
}

const emailDraftDir = "email-drafts";
if (!fs.existsSync(emailDraftDir)) {
    fs.mkdirSync(emailDraftDir, { recursive: true });
    console.log(`メール下書きディレクトリを作成しました: ${emailDraftDir}`);
}

/**
 * メール受信ボックスから特定の件名の未読メールを取得し、リンクをクリックする
 */
test("バイトル応募メールのリンクをクリック", async ({ page }) => {
    // テストタイムアウトを5分に延長
    test.setTimeout(300000);

    // メール機能をスキップするフラグ
    const SKIP_EMAIL = process.env.SKIP_EMAIL === "true";
    const SKIP_MAIL_DRAFT = process.env.SKIP_MAIL_DRAFT === "true";
    let sendMailEnabled = false;
    let sendSmsEnabled = false;

    if (SKIP_EMAIL) {
        console.log("⚠️ メール機能をスキップします (SKIP_EMAIL=true)");
        console.log("テスト用のダミーリンクでブラウザテストを実行します");

        // テスト用のダミーリンク（実際のバイトルサイト）
        const testLink = "https://www.baitoru.com/";

        try {
            await page.goto(testLink, {
                waitUntil: "networkidle",
                timeout: 30000,
            });

            await page.waitForLoadState("domcontentloaded");

            const timestamp = formatTimestampJST();
            await page.screenshot({
                path: `screenshots/recruit/baitoru_test_${timestamp}.png`,
                fullPage: true,
            });

            console.log(`✅ テストリンクを正常に開きました: ${testLink}`);
            console.log(
                `📸 スクリーンショットを保存しました: screenshots/recruit/baitoru_test_${timestamp}.png`
            );
        } catch (browserError) {
            const errorMsg = browserError instanceof Error ? browserError.message : String(browserError);
            console.error(
                `❌ ブラウザテストでエラーが発生しました: ${errorMsg}`
            );
            throw browserError;
        }

        return;
    }

    try {
        console.log("メール受信ボックスに接続中...");

        const tenantId = resolveTenantId(process.env.BAITORU_TENANT_ID ?? process.env.TENANT_ID);
        const baitoruCredentials = await fetchPrimaryBaitoruCredentials(tenantId);
        const mailSettings = await fetchMailSettings(tenantId);
        const chatworkSettings = await fetchChatworkSettings(tenantId);
        const smsSettings = await fetchSmsSettings(tenantId);
        const emailUser = mailSettings.replyEmail;
        const emailPass = mailSettings.gmailAppKey;

        // mail_settings.is_active を送信フラグとして利用
        sendMailEnabled = !!mailSettings.isActive;
        // sms_settings.is_active を送信フラグとして利用
        sendSmsEnabled = !!smsSettings.isActive;

        if (!emailUser || !emailPass) {
            console.warn("mail_settingsからEMAIL_USER/EMAIL_PASS相当の情報を取得できませんでした。メール処理をスキップします。");
            return;
        }
        if (!mailSettings.subject) {
            console.warn("mail_settings.subject が設定されていないためメール件名を生成できません。メール処理をスキップします。");
            return;
        }
        if (!mailSettings.content) {
            console.warn("mail_settings.content が設定されていないためメール本文を生成できません。メール処理をスキップします。");
            return;
        }

        // メール送信用の認証情報をセット（環境変数は使わず、DB由来の値を直接利用）
        setMailCredentials({ user: emailUser, pass: emailPass });

        setChatworkConfig({
            enabled: !!chatworkSettings.isActive,
            apiToken: chatworkSettings.apiToken,
            roomId: chatworkSettings.roomId,
        });

        // IMAP設定
        const config = {
            imap: {
                user: emailUser,
                password: emailPass,
                host: "imap.gmail.com",
                port: 993,
                tls: true,
                tlsOptions: {
                    rejectUnauthorized: false,
                },
                authTimeout: 10000,
                connTimeout: 10000,
                keepalive: true,
            },
        };

        // IMAPサーバーに接続
        const connection = await imaps.connect(config);
        console.log("メールサーバーに接続しました");

        // INBOXを開く
        await connection.openBox("INBOX");
        console.log("受信ボックスを開きました");

        // 未読メールを検索（件名に「【バイトル】お仕事への応募がありました。」または「【バイトル】お仕事への体験応募がありました。」を含む）
        const searchCriteria = [
            "UNSEEN", // 未読
            [
                "OR",
                ["SUBJECT", "【バイトル】お仕事への応募がありました。"],
                ["SUBJECT", "【バイトル】お仕事への体験応募がありました。"],
            ],
        ];

        const fetchOptions = {
            bodies: "",
            markSeen: false,
            struct: true,
            envelope: true,
        };

        console.log("未読のバイトル応募メールを検索中...");
        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length === 0) {
            console.log("該当する未読メールが見つかりませんでした");
            await connection.end();
            return;
        }

        console.log(`${messages.length}件の未読バイトル応募メールが見つかりました`);

        // 各メールを処理
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            console.log(`メール ${i + 1}/${messages.length} を処理中...`);

            try {
                // メール本文を取得（HTML優先、なければプレーンテキスト）
                const parts = imaps.getParts(message.attributes.struct || []);
                /**
                 * @typedef {Object} MessagePart
                 * @property {string} type - The type of the message part (e.g., "text").
                 * @property {string} subtype - The subtype of the message part (e.g., "html").
                 * @property {Object} [disposition] - The disposition of the message part (e.g., "attachment").
                 * @param {string} preferredSubtype - The preferred subtype (e.g., "html" or "plain").
                 * @returns {MessagePart | undefined} - The matching message part or undefined if not found.
                 */
                const pickBodyPart = (preferredSubtype) =>
                    parts.find((part) => {
                        if (part.disposition) return false;
                        const type =
                            typeof part.type === "string"
                                ? part.type.toLowerCase()
                                : "";
                        const subtype =
                            typeof part.subtype === "string"
                                ? part.subtype.toLowerCase()
                                : "";
                        return type === "text" && subtype === preferredSubtype;
                    });

                const bodyPart = pickBodyPart("html") || pickBodyPart("plain");

                if (!bodyPart) {
                    throw new Error("メール本文のパートを特定できませんでした");
                }

                const rawBody = await connection.getPartData(message, bodyPart);
                const parsed = await simpleParser(rawBody);

                const envelope = /** @type {any} */ (message.attributes || {}).envelope;
                const subject =
                    (envelope && envelope.subject) || parsed.subject || "(件名なし)";
                const fromAddresses = envelope?.from || [];
                let fromText = "";
                if (fromAddresses.length > 0) {
                    /**
                     * @typedef {Object} Address
                     * @property {string} [mailbox] - The mailbox part of the email address.
                     * @property {string} [host] - The host part of the email address.
                     * @property {string} [name] - The name associated with the email address.
                     */

                    /**
                     * @type {Address[]}
                     */
                    const fromAddressesTyped = fromAddresses;

                    fromText = fromAddressesTyped
                        .map((addr) => {
                            const mailbox = addr.mailbox || "";
                            const host = addr.host || "";
                            const email = mailbox && host ? `${mailbox}@${host}` : "";
                            const name = addr.name ? addr.name.trim() : "";
                            return name && email ? `${name} <${email}>` : email || name;
                        })
                        .filter(Boolean)
                        .join(", ");
                }
                if (!fromText && parsed.from?.text) {
                    fromText = parsed.from.text;
                }
                if (!fromText) {
                    fromText = "(送信者情報なし)";
                }

                console.log(`件名: ${subject}`);
                console.log(`送信者: ${fromText}`);

                // メール本文からhttps://agent.baitoru.com/entry/show/で始まるリンクを抽出
                let emailBody = "";
                if (parsed.html) {
                    emailBody = parsed.html;
                } else if (parsed.text) {
                    emailBody = parsed.text;
                }

                const emailText = parsed.text || emailBody.replace(/<[^>]*>/g, " ");
                const emailApplicantInfo = extractApplicantInfo(emailText);
                const applicantAgeFromEmail = emailApplicantInfo.age;
                const applicantGenderFromEmail = normalizeGender(emailApplicantInfo.gender);
                const applicantOccupationFromEmail = emailApplicantInfo.occupation?.trim() || null;

                if (typeof applicantAgeFromEmail === "number") {
                    console.log(`メール記載の応募者年齢: ${applicantAgeFromEmail}`);
                }
                if (applicantGenderFromEmail) {
                    console.log(`メール記載の応募者性別: ${applicantGenderFromEmail}`);
                }
                if (applicantOccupationFromEmail) {
                    console.log(`メール記載の応募者職業: ${applicantOccupationFromEmail}`);
                }

                const links = extractBaitoruLinks(emailBody);

                if (links && links.length > 0) {
                    console.log(`見つかったリンク: ${links[0]}`);

                    try {
                        // ブラウザでリンクを開く
                        console.log("ブラウザでリンクを開いています...");
                        await page.goto(links[0], {
                            waitUntil: "networkidle",
                            timeout: 30000,
                        });

                        // ページが正常に読み込まれたかチェック
                        await page.waitForLoadState("domcontentloaded");

                        // ログイン処理
                        await page.getByRole('textbox', { name: 'E メールアドレス' }).click();
                        await page.getByRole('textbox', { name: 'E メールアドレス' }).fill(baitoruCredentials.loginMail || "");
                        await page.getByRole('textbox', { name: 'パスワード' }).click();
                        await page.getByRole('textbox', { name: 'パスワード' }).fill(baitoruCredentials.loginPassword || "");
                        await page.getByRole('button', { name: 'サインイン' }).click();

                        // 応募企業名を取得
                        const companyElement = await page.waitForSelector(
                            ".nav-comp-name span",
                            { timeout: 15000 }
                        );
                        const companyTextRaw = (
                            (await companyElement.textContent()) || ""
                        ).trim();
                        const companyNameMatch = companyTextRaw.match(/^(.+?)\s*様/);
                        const companyName = companyNameMatch?.[1]?.trim() || companyTextRaw;
                        const companyIdMatch = companyTextRaw.match(/様\s*([0-9]+)/);
                        const companyId = companyIdMatch ? Number.parseInt(companyIdMatch[1], 10) : null;
                        console.log(`応募企業: ${companyName}`);
                        console.log(`勤務地名: ${companyName}`);
                        if (companyId) {
                            console.log(`応募企業ID: ${companyId}`);
                        } else {
                            console.warn(`応募企業IDを取得できませんでした: ${companyTextRaw}`);
                        }

                        // 仕事No を取得
                        let jobNumber = "";
                        let jobName = "";
                        let jobAddress = "";
                        let interviewAddress = "";
                        let companyUrl = "";
                        try {
                            // 応募内容テーブルに限定して情報を抜き取る
                            const entryDetails = page.locator('td:has-text("応募内容") + td');
                            await entryDetails.waitFor({ state: "visible", timeout: 15000 });

                            const jobNumberLocator = entryDetails.locator('div:has-text("仕事No") span').first();
                            const jobNumberText = (await jobNumberLocator.textContent()) || "";
                            jobNumber = jobNumberText.trim();
                            const jobNameLocator = entryDetails.locator('div:has-text("業務名") span').first();
                            const jobNameText = (await jobNameLocator.textContent()) || "";
                            jobName = jobNameText.trim();
                            const jobAddressLocator = entryDetails.locator('div:has-text("勤務先住所") span').first();
                            const jobAddressText = (await jobAddressLocator.textContent()) || "";
                            jobAddress = jobAddressText.trim();
                            if (jobNumber) {
                                console.log(`仕事No: ${jobNumber}`);
                            } else {
                                console.warn("仕事Noを取得できませんでした");
                            }
                            if (jobName) {
                                console.log(`業務名: ${jobName}`);
                            } else {
                                console.warn("業務名を取得できませんでした");
                            }
                            if (jobAddress) {
                                console.log(`勤務先住所: ${jobAddress}`);
                            } else {
                                console.warn("勤務先住所を取得できませんでした");
                            }
                        } catch (jobErr) {
                            console.warn("仕事No取得時にエラーが発生しました:", jobErr);
                        }

                        // 応募者名を取得
                        const applicantNameLocator = page.locator(
                            ".panel-title-name > span"
                        );
                        const applicantKanaLocator = page.locator(
                            ".panel-title-name small span"
                        );
                        const applicantName = (
                            (await applicantNameLocator.first().textContent()) || ""
                        ).trim();
                        const applicantKana = (
                            (await applicantKanaLocator.first().textContent()) || ""
                        ).trim();
                        const applicantFurigana = applicantKana || applicantName;
                        if (applicantFurigana) {
                            console.log(`応募者名: ${applicantFurigana}`);
                        } else {
                            console.log("応募者名: (取得できませんでした)");
                        }

                        let applicantAge: number | null = null;
                        try {
                            const applicantProfileLocator = page.locator("div.mb15").first();
                            const applicantProfileText = (await applicantProfileLocator.innerText()) || "";
                            const ageMatch = applicantProfileText.match(/(\d+)\s*歳/);
                            applicantAge = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;
                            if (typeof applicantAge === "number" && Number.isFinite(applicantAge)) {
                                console.log(`応募者年齢: ${applicantAge}`);
                            } else {
                                console.warn(`応募者年齢を取得できませんでした: ${applicantProfileText}`);
                                applicantAge = null;
                            }
                        } catch (ageErr) {
                            console.warn("応募者年齢の取得時にエラーが発生しました:", ageErr);
                        }

                        const broadcastApplicantAge =
                            typeof applicantAgeFromEmail === "number" ? applicantAgeFromEmail : applicantAge;
                        const broadcastApplicantGender = applicantGenderFromEmail;
                        const broadcastApplicantOccupation = applicantOccupationFromEmail;

                        let broadcastConditions = [];
                        if (typeof companyId === "number" && Number.isFinite(companyId)) {
                            try {
                                broadcastConditions = await fetchStoreBroadcastConditions(tenantId, companyId);
                                if (broadcastConditions.length === 0) {
                                    console.warn(`store_broadcast_conditionsに対象条件が見つかりませんでした: company_id=${companyId}`);
                                }
                            } catch (storeErr) {
                                console.warn("配信条件の取得時にエラーが発生しました:", storeErr);
                            }
                        }

                        if (!matchesBroadcastConditions(broadcastConditions, {
                            age: broadcastApplicantAge,
                            gender: broadcastApplicantGender,
                            occupation: broadcastApplicantOccupation,
                        })) {
                            console.log("応募者が配信条件に一致しないためスキップします");
                            await connection.addFlags(message.attributes.uid, "\\Seen");
                            console.log("メールを既読にマークしました");
                            await page.waitForTimeout(2000);
                            continue;
                        }

                        // 応募受付先（$CONTACT）を取得
                        let contactName = "";
                        let contactTel = "";
                        try {
                            const contactLocator = page.locator('td:has-text("応募受付先") + td .row .col-md-4 span').first();
                            const contactText = (await contactLocator.textContent()) || "";
                            contactName = contactText.trim();
                            const telLocator = page.locator('td:has-text("応募受付先") + td .row .col-md-4:has-text("TEL番号") span').first();
                            const telText = (await telLocator.textContent()) || "";
                            contactTel = telText.trim();
                            if (contactName) {
                                console.log(`応募受付先: ${contactName}`);
                            } else {
                                console.warn("応募受付先の情報を取得できませんでした");
                            }
                            if (contactTel) {
                                console.log(`応募受付先TEL: ${contactTel}`);
                            } else {
                                console.warn("応募受付先のTELを取得できませんでした");
                            }
                        } catch (contactErr) {
                            console.warn("応募受付先の取得時にエラーが発生しました:", contactErr);
                        }

                        // 応募者情報と連絡手段を取得
                        let applicantEmail = "";
                        let applicantTel = "";
                        const emailLink = await page.waitForSelector(
                            "a.btn-entry-email",
                            { timeout: 15000 }
                        );
                        const emailText = (
                            (await emailLink.textContent()) || ""
                        ).trim();
                        applicantEmail = emailText;
                        console.log(`応募者メールアドレス: ${emailText}`);

                        const telLink = await page.waitForSelector(
                            "a.btn-entry-tel",
                            { timeout: 15000 }
                        );
                        const telSpan = await telLink.$("span");
                        const telText = telSpan ? (await telSpan.innerText()).trim() : "(電話番号情報なし)";
                        applicantTel = telText;
                        console.log(`応募者電話番号: ${telText}`);

                        // 面接地住所を取得（原稿 -> ロケーション経由）
                        try {
                            const entryPageUrl = page.url();
                            await page.getByRole('link', { name: ' 原稿 ' }).click();
                            await page.waitForLoadState("networkidle");
                            await page.getByRole('link', { name: ' ロケーション' }).click();
                            await page.waitForLoadState("networkidle");
                            const interviewLocator = page.locator('td.td-05 p.td-03').first();
                            await interviewLocator.waitFor({ state: "visible", timeout: 15000 });
                            const interviewText = (await interviewLocator.innerText()) || "";
                            interviewAddress = interviewText.trim();
                            if (interviewAddress) {
                                console.log(`面接地住所: ${interviewAddress}`);
                            } else {
                                console.warn("面接地住所を取得できませんでした");
                            }
                            // 会社情報から会社URLを取得
                            await page.getByRole('link', { name: ' 会社情報' }).click();
                            await page.waitForLoadState("networkidle");
                            const companyUrlInput = page.getByRole('textbox', { name: '会社URL' });
                            await companyUrlInput.waitFor({ state: "visible", timeout: 15000 });
                            const urlValue = await companyUrlInput.inputValue();
                            companyUrl = (urlValue || "").trim();
                            if (companyUrl) {
                                console.log(`会社URL: ${companyUrl}`);
                            } else {
                                console.warn("会社URLを取得できませんでした");
                            }
                            // 元のページに戻る
                            if (entryPageUrl) {
                                await page.goto(entryPageUrl, {
                                    waitUntil: "domcontentloaded",
                                    timeout: 30000,
                                });
                                await page.waitForLoadState("networkidle");
                            }
                        } catch (interviewErr) {
                            console.warn("面接地住所取得時にエラーが発生しました:", interviewErr);
                        }

                        const { to, subject, body, raw } = buildRecruitEmailDraft({
                            companyName,
                            applicantName,
                            applicantFurigana,
                            applicantAge: broadcastApplicantAge,
                            applicantGender: broadcastApplicantGender,
                            applicantOccupation: broadcastApplicantOccupation,
                            applicantEmail,
                            subjectTemplate: mailSettings.subject || undefined,
                            contentTemplate: mailSettings.content || undefined,
                            jobNumber,
                            contactName,
                            contactTel,
                            jobName,
                            jobAddress,
                            interviewAddress,
                            companyUrl,
                            workplaceName: companyName,
                        });
                        const draftFileName = `draft_${formatTimestampJST()}.txt`;
                        const draftPath = path.join(emailDraftDir, draftFileName);
                        fs.writeFileSync(draftPath, raw, "utf8");
                        console.log(`応募者向けメールの下書きを保存しました: ${draftPath}`);

                        if (SKIP_MAIL_DRAFT) {
                            console.log(
                                "⚠️ 応募者向けメールのGmail下書き作成をスキップします (SKIP_MAIL_DRAFT=true)"
                            );
                        } else {
                            await saveRecruitEmailDraftToGmail({
                                connection,
                                to,
                                subject,
                                body,
                            });
                            console.log(`応募者向けメールをGmailの下書きに保存しました: ${to}`);
                        }

                        if (sendMailEnabled) {
                            try {
                                await sendRecruitEmail({ to, subject, body });
                                console.log(`応募者へメールを送信しました: ${to}`);
                                try {
                                    await notifyRecruitProspectMessageEvent({
                                        tenantId,
                                        sourceType: 'baitoru',
                                        sourceJobNo: jobNumber,
                                        sourceCompanyName: companyName,
                                        applicantName: applicantName,
                                        applicantNameKana: applicantFurigana,
                                        phone: applicantTel,
                                        email: to,
                                        channel: 'mail',
                                        deliveryType: 'email',
                                        templateKey: 'baitoru_initial_mail',
                                        payload: {
                                            subject,
                                            body,
                                            workplaceName: companyName,
                                        },
                                        meta: {
                                            contactName,
                                            contactTel,
                                            jobName,
                                            jobAddress,
                                            interviewAddress,
                                            companyUrl,
                                        },
                                    });
                                } catch (prospectErr) {
                                    const prospectMsg = prospectErr instanceof Error ? prospectErr.message : String(prospectErr);
                                    console.error(`recruit prospects API連携(メール)に失敗しました: ${prospectMsg}`);
                                }
                                // Chatwork 通知（成功）
                                await notifyEmailResult({
                                    to,
                                    subject,
                                    status: "SUCCESS",
                                    emailBody: body,
                                });
                            } catch (mailErr) {
                                const mailMsg = mailErr instanceof Error ? mailErr.message : String(mailErr);
                                console.error(`応募者へのメール送信に失敗しました: ${mailMsg}`);
                                // Chatwork 通知（失敗）
                                await notifyEmailResult({
                                    to,
                                    subject,
                                    status: "FAIL",
                                    detail: mailMsg,
                                    emailBody: body,
                                });
                            }

                        } else {
                            console.log("ℹ️ 応募者へのメール送信は無効化されています (mail_settings.is_active=false)");
                            await notifyEmailResult({
                                to,
                                subject,
                                status: "SKIPPED",
                                detail: "mail_settings.is_active=false",
                                emailBody: body,
                            });
                        }

                        // await emailLink.click();
                        // クリックは不要。リンクテキスト（メールアドレス）の取得のみ行う

                        if (sendSmsEnabled) {
                            try {
                                const smsSendResult = await sendAixMessage({
                                    settings: smsSettings,
                                    phoneNumber: applicantTel,
                                    bodyReplacements: {
                                        companyName,
                                        applicantName: applicantFurigana || applicantName,
                                        jobNumber,
                                        jobName,
                                        jobAddress,
                                        contactName,
                                        contactTel,
                                        interviewAddress,
                                        companyUrl,
                                        workplaceName: companyName,
                                    },
                                });

                                console.log(`応募者へSMS/RCSを送信しました: ${applicantTel}`);
                                try {
                                    await notifyRecruitProspectMessageEvent({
                                        tenantId,
                                        sourceType: 'baitoru',
                                        sourceJobNo: jobNumber,
                                        sourceCompanyName: companyName,
                                        applicantName: applicantName,
                                        applicantNameKana: applicantFurigana,
                                        phone: applicantTel,
                                        email: applicantEmail,
                                        channel: smsSendResult?.apiType === 2 ? 'rcs' : 'sms',
                                        deliveryType: String(smsSendResult?.apiType || 'sms'),
                                        templateKey: smsSendResult?.apiTemplateId || 'baitoru_initial_sms',
                                        payload: {
                                            smsBody: smsSendResult?.smsText,
                                            apiType: smsSendResult?.apiType,
                                            apiTemplateId: smsSendResult?.apiTemplateId,
                                        },
                                        meta: {
                                            contactName,
                                            contactTel,
                                            jobName,
                                            jobAddress,
                                            interviewAddress,
                                            companyUrl,
                                        },
                                    });
                                } catch (prospectErr) {
                                    const prospectMsg = prospectErr instanceof Error ? prospectErr.message : String(prospectErr);
                                    console.error(`recruit prospects API連携(SMS/RCS)に失敗しました: ${prospectMsg}`);
                                }
                                await notifySmsResult({
                                    to: applicantTel,
                                    status: "SUCCESS",
                                    smsBody: smsSendResult?.smsText,
                                });
                            } catch (smsError) {
                                const smsMessage = smsError instanceof Error ? smsError.message : String(smsError);
                                console.error(`SMS/RCS送信に失敗しました: ${smsMessage}`);
                                await notifySmsResult({
                                    to: applicantTel || "(unknown)",
                                    status: "FAIL",
                                    detail: smsMessage,
                                });
                            }
                        } else {
                            console.log("ℹ️ 応募者へのSMS送信は無効化されています (sms_settings.is_active=false)");
                            await notifySmsResult({
                                to: applicantTel || "(no phone)",
                                status: "SKIPPED",
                                detail: "sms_settings.is_active=false",
                            });
                        }
                        // await telLink.click();
                        // クリックは不要。リンク内のspanテキスト（電話番号）の取得のみ行う

                        // スクリーンショットを撮影
                        const timestamp = formatTimestampJST();
                        await page.screenshot({
                            path: `screenshots/recruit/baitoru_entry_${timestamp}.png`,
                            fullPage: true,
                        });

                        console.log(`リンクを正常に開きました: ${links[0]}`);
                        console.log(
                            `スクリーンショットを保存しました: screenshots/recruit/baitoru_entry_${timestamp}.png`
                        );

                        // メールを既読にマーク
                        await connection.addFlags(message.attributes.uid, "\\Seen");
                        console.log("メールを既読にマークしました");

                        // 少し待機してから次のメールへ
                        await page.waitForTimeout(2000);
                    } catch (browserError) {
                        const errorMsg =
                            browserError instanceof Error
                                ? browserError.message
                                : String(browserError);
                        console.error(`リンクを開く際にエラーが発生しました: ${errorMsg}`);
                        console.error(`問題のあるリンク: ${links[0]}`);
                    }
                } else {
                    console.log(
                        "メール本文にバイトルのエントリーリンクが見つかりませんでした"
                    );
                    console.log("メール本文の一部:");
                    console.log(emailBody.substring(0, 500) + "...");
                }
            } catch (messageError) {
                const errorMsg =
                    messageError instanceof Error
                        ? messageError.message
                        : String(messageError);
                console.error(`メール処理中にエラーが発生しました: ${errorMsg}`);
            }
        }

        // IMAP接続を閉じる
        await connection.end();
        console.log("メールサーバーとの接続を閉じました");
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : "";
        console.error(`エラーが発生しました: ${errorMsg}`);
        console.error("スタックトレース:", errorStack);
        throw error;
    }
});

/**
 * メール本文からリンクを抽出するヘルパー関数
 * @param {string} text - メール本文
 * @returns {string[]} - 抽出されたリンクの配列
 */
function extractBaitoruLinks(text) {
    if (!text) return [];

    // HTMLタグを除去
    const cleanText = text.replace(/<[^>]*>/g, " ");

    // バイトルのエントリーリンクを抽出
    const linkRegex =
        /https:\/\/agent\.baitoru\.com\/entry\/show\/[^\s\n\r<>"']+/g;
    const matches = cleanText.match(linkRegex);

    return matches || [];
}

/**
 * JST（日本標準時）のタイムスタンプ文字列を生成
 * @returns {string}
 */
function formatTimestampJST() {
    const formatter = new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });

    const parts = formatter.formatToParts(new Date());
    /** @type {{ [key: string]: string }} */
    const values = {};

    for (const part of parts) {
        if (part.type === "literal") continue;
        values[part.type] = part.value;
    }

    /**
     * Safely retrieves a value from the `values` object and pads it to a minimum length.
     * @param {keyof typeof values} key - The key to retrieve from the `values` object.
     * @param {string} fallback - The fallback value if the key is not found or invalid.
     * @returns {string} - The padded value or the fallback.
     */
    const safe = (key, fallback) => (values[key] && values[key].padStart(2, "0")) || fallback;

    return `${safe("year", "0000")}-${safe("month", "00")}-${safe("day", "00")}_${safe("hour", "00")}-${safe("minute", "00")}-${safe("second", "00")}`;
}

function extractApplicantInfo(text) {
    const normalized = String(text || "").replace(/\u00a0/g, " ");
    const ageMatch = normalized.match(/年齢\s*[：:]\s*(\d{1,3})/);
    const genderMatch = normalized.match(/性別\s*[：:]\s*([^\s　\n\r]+)/);
    const occupationMatch =
        normalized.match(/現在の職業\s*[：:]\s*([^\n\r]+)/) ||
        normalized.match(/現在の職業\s*[：:]\s*([^\s　\n\r]+)/);

    const age = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;
    const gender = genderMatch ? genderMatch[1].trim() : null;
    const occupation = occupationMatch ? occupationMatch[1].trim() : null;

    return { age, gender, occupation };
}

function normalizeGender(value) {
    if (!value) return null;
    const normalized = String(value).trim();
    if (!normalized) return null;
    if (normalized === "男") return "男性";
    if (normalized === "女") return "女性";
    return normalized;
}

function normalizeOccupation(value) {
    if (!value) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function matchesBroadcastConditions(conditions, applicant) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
        return true;
    }

    const applicantAge = typeof applicant?.age === "number" ? applicant.age : null;
    const applicantGender = normalizeGender(applicant?.gender);
    const applicantOccupation = normalizeOccupation(applicant?.occupation);

    return conditions.some((condition) => {
        const ageMin = typeof condition?.ageMin === "number" ? condition.ageMin : null;
        const ageMax = typeof condition?.ageMax === "number" ? condition.ageMax : null;
        const conditionGender = normalizeGender(condition?.gender);
        if (!conditionGender || applicantGender !== conditionGender) {
            return false;
        }

        if (ageMin !== null || ageMax !== null) {
            if (applicantAge === null) {
                return false;
            }
            if (ageMin !== null && applicantAge < ageMin) {
                return false;
            }
            if (ageMax !== null && applicantAge > ageMax) {
                return false;
            }
        }

        const excluded = Array.isArray(condition?.excludedOccupations)
            ? condition.excludedOccupations.map(normalizeOccupation).filter(Boolean)
            : [];
        if (excluded.length > 0 && applicantOccupation) {
            if (excluded.includes(applicantOccupation)) {
                return false;
            }
        }

        return true;
    });
}
