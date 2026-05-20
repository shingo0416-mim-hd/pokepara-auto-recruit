import { test } from '@playwright/test';
import imaps from 'imap-simple';
import { simpleParser } from 'mailparser';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { buildRecruitEmailDraft, sendRecruitEmail, setMailCredentials } from './helpers/mail';
import { sendAixMessage } from './helpers/sms';
import { notifyEmailResult, notifySmsResult, setChatworkConfig } from './helpers/chatwork';
import { fetchChatworkSettings, fetchMailSettings, fetchSmsSettings, resolveTenantId } from './helpers/db';
import { notifyRecruitProspectMessageEvent } from './helpers/recruitProspects';

dotenv.config();

const screenshotDir = 'screenshots/recruit';
if (!fs.existsSync(screenshotDir)) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  console.log(`スクリーンショットディレクトリを作成しました: ${screenshotDir}`);
}

const emailDraftDir = 'email-drafts';
if (!fs.existsSync(emailDraftDir)) {
  fs.mkdirSync(emailDraftDir, { recursive: true });
  console.log(`メール下書きディレクトリを作成しました: ${emailDraftDir}`);
}

const POKEPARA_SUBJECT_PREFIX = '【ポケパラ】求人応募';

test('ポケパラ求人応募メールのリンクをクリック', async ({ page }) => {
  test.setTimeout(120000);

  if (process.env.SKIP_EMAIL === 'true') {
    console.log('⚠️ メール機能をスキップします (SKIP_EMAIL=true)');
    await page.goto('https://www.pokepara.jp/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    return;
  }

  let connection: any | null = null;

  try {
    console.log('メール受信ボックスに接続中...');

    const tenantId = resolveTenantId(process.env.POKEPARA_TENANT_ID ?? process.env.TENANT_ID);
    const mailSettings = await fetchMailSettings(tenantId);
    const chatworkSettings = await fetchChatworkSettings(tenantId);
    const smsSettings = await fetchSmsSettings(tenantId);
    const emailUser = mailSettings.replyEmail;
    const emailPass = mailSettings.gmailAppKey;

    setChatworkConfig({
      enabled: !!chatworkSettings.isActive,
      apiToken: chatworkSettings.apiToken,
      roomId: chatworkSettings.roomId,
    });

    if (!emailUser || !emailPass) {
      console.warn('mail_settingsからEMAIL_USER/EMAIL_PASS相当の情報を取得できませんでした。メール処理をスキップします。');
      return;
    }
    setMailCredentials({ user: emailUser, pass: emailPass });

    connection = await imaps.connect({
      imap: {
        user: emailUser,
        password: emailPass,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: {
          rejectUnauthorized: false,
        },
        authTimeout: 10000,
        connTimeout: 10000,
        keepalive: true,
      },
    });
    console.log('メールサーバーに接続しました');

    await connection.openBox('INBOX');
    console.log('受信ボックスを開きました');

    const messages = await connection.search(
      ['UNSEEN', ['SUBJECT', POKEPARA_SUBJECT_PREFIX]],
      {
        bodies: '',
        markSeen: false,
        struct: true,
        envelope: true,
      },
    );

    if (messages.length === 0) {
      console.log('該当する未読メールが見つかりませんでした');
      return;
    }

    console.log(`${messages.length}件の未読ポケパラ求人応募メールが見つかりました`);

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      console.log(`メール ${i + 1}/${messages.length} を処理中...`);

      try {
        const rawBody = await getPreferredBody(connection, message);
        const parsed = await simpleParser(rawBody);
        const subject = message.attributes?.envelope?.subject || parsed.subject || '(件名なし)';
        console.log(`件名: ${subject}`);

        if (!subject.startsWith(POKEPARA_SUBJECT_PREFIX)) {
          console.log(`件名がポケパラ求人応募メールの形式ではないためスキップします: ${subject}`);
          continue;
        }

        const emailBody = parsed.html || parsed.text || String(rawBody || '');
        const links = extractPokeparaLinks(emailBody);
        const companyNameFromEmail = extractPokeparaCompanyName(emailBody);

        if (links.length === 0) {
          console.log('メール本文にポケパラ求人応募リンクが見つかりませんでした');
          console.log('メール本文の一部:');
          console.log(String(emailBody).substring(0, 500) + '...');
          continue;
        }

        const targetLink = links[0];
        console.log(`見つかったリンク: ${targetLink}`);
        console.log('ブラウザでリンクを開いています...');

        await page.goto(targetLink, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        const {
          applicantEmail,
          applicantTel,
          applicantName,
          application,
          companyName: companyNameFromPage,
        } = await extractPokeparaApplicantContact(page);
        const companyName = companyNameFromPage || companyNameFromEmail;
        const sourceMessageId = extractPokeparaMessageId(targetLink) || String(message.attributes?.uid || '');

        if (companyName) {
          console.log(`応募店舗名: ${companyName}`);
        } else {
          console.warn('応募店舗名を取得できませんでした');
        }
        if (applicantName) {
          console.log(`応募者名: ${applicantName}`);
        } else {
          console.warn('応募者名を取得できませんでした');
        }
        if (applicantEmail) {
          console.log(`応募者メールアドレス: ${applicantEmail}`);
        } else {
          console.warn('応募者メールアドレスを取得できませんでした');
        }
        if (applicantTel) {
          console.log(`応募者電話番号: ${applicantTel}`);
        } else {
          console.warn('応募者電話番号を取得できませんでした');
        }

        await notifyRecruitProspectSafely({
          tenantId,
          sourceType: 'pokepara',
          sourceJobNo: sourceMessageId,
          sourceCompanyName: companyName,
          applicantName,
          applicantNameKana: applicantName,
          phone: applicantTel,
          email: applicantEmail,
          channel: 'source',
          deliveryType: 'pokepara_job_application',
          templateKey: 'pokepara_job_application_received',
          externalMessageId: sourceMessageId ? `pokepara:${sourceMessageId}` : undefined,
          status: 'received',
          payload: {
            subject,
            link: targetLink,
            application,
          },
          meta: {
            source: 'pokepara',
            sourceMessageId,
            sourceUrl: targetLink,
            companyName,
            applicantName,
            applicantEmail,
            applicantTel,
            ...application,
          },
        });

        if (applicantEmail && mailSettings.subject && mailSettings.content) {
          const { to, subject: draftSubject, body, raw } = buildRecruitEmailDraft({
            companyName,
            workplaceName: companyName,
            applicantName,
            applicantFurigana: applicantName,
            applicantEmail,
            subjectTemplate: mailSettings.subject,
            contentTemplate: mailSettings.content,
          });
          const draftPath = path.join(emailDraftDir, `pokepara_draft_${formatTimestampJST()}.txt`);
          fs.writeFileSync(draftPath, raw, 'utf8');
          console.log(`応募者向けメールの下書きを保存しました: ${draftPath}`);

          if (mailSettings.isActive) {
            try {
              await sendRecruitEmail({ to, subject: draftSubject, body });
              console.log(`応募者へメールを送信しました: ${to}`);
              await notifyEmailResult({
                to,
                subject: draftSubject,
                status: 'SUCCESS',
                detail: `ポケパラ応募者向けメールを送信しました。下書き保存先: ${draftPath}`,
                emailBody: body,
              });
              await notifyRecruitProspectSafely({
                tenantId,
                sourceType: 'pokepara',
                sourceJobNo: sourceMessageId,
                sourceCompanyName: companyName,
                applicantName,
                applicantNameKana: applicantName,
                phone: applicantTel,
                email: to,
                channel: 'mail',
                deliveryType: 'email',
                templateKey: 'pokepara_initial_mail',
                status: 'sent',
                payload: {
                  subject: draftSubject,
                  body,
                },
                meta: {
                  sourceUrl: targetLink,
                  ...application,
                },
              });
            } catch (mailError) {
              const mailMessage = mailError instanceof Error ? mailError.message : String(mailError);
              console.error(`応募者へのメール送信に失敗しました: ${mailMessage}`);
              await notifyEmailResult({
                to,
                subject: draftSubject,
                status: 'FAIL',
                detail: mailMessage,
                emailBody: body,
              });
            }
          } else {
            console.log('応募者へのメール送信は無効化されています (mail_settings.is_active=false)');
            await notifyEmailResult({
              to,
              subject: draftSubject,
              status: 'SKIPPED',
              detail: `mail_settings.is_active=false。下書き保存先: ${draftPath}`,
              emailBody: body,
            });
          }
        } else {
          console.log('応募者向けメールの下書き作成をスキップしました');
          await notifyEmailResult({
            to: applicantEmail || '(no email)',
            subject: mailSettings.subject || '(no subject)',
            status: 'SKIPPED',
            detail: '応募者メールアドレス、mail_settings.subject、mail_settings.content のいずれかが未取得です',
          });
        }

        if (applicantTel && smsSettings.isActive) {
          try {
            const smsSendResult = await sendAixMessage({
              settings: smsSettings,
              phoneNumber: applicantTel,
              bodyReplacements: {
                companyName,
                workplaceName: companyName,
                applicantName,
              },
            });

            const smsBody = smsSendResult?.apiType === 2 ? smsSendResult?.rcsText : smsSendResult?.smsText;
            console.log(`応募者へSMS/RCSを送信しました: ${applicantTel}`);
            await notifySmsResult({
              to: applicantTel,
              status: 'SUCCESS',
              smsBody,
            });
            await notifyRecruitProspectSafely({
              tenantId,
              sourceType: 'pokepara',
              sourceJobNo: sourceMessageId,
              sourceCompanyName: companyName,
              applicantName,
              applicantNameKana: applicantName,
              phone: applicantTel,
              email: applicantEmail,
              channel: smsSendResult?.apiType === 2 ? 'rcs' : 'sms',
              deliveryType: String(smsSendResult?.apiType || 'sms'),
              templateKey: smsSendResult?.apiTemplateId || 'pokepara_initial_sms',
              status: 'sent',
              payload: {
                smsBody,
                smsText: smsSendResult?.smsText,
                rcsText: smsSendResult?.rcsText,
                apiType: smsSendResult?.apiType,
                apiTemplateId: smsSendResult?.apiTemplateId,
              },
              meta: {
                sourceUrl: targetLink,
                ...application,
              },
            });
          } catch (smsError) {
            const smsMessage = smsError instanceof Error ? smsError.message : String(smsError);
            console.error(`SMS/RCS送信に失敗しました: ${smsMessage}`);
            await notifySmsResult({
              to: applicantTel,
              status: 'FAIL',
              detail: smsMessage,
            });
          }
        } else {
          const detail = applicantTel ? 'sms_settings.is_active=false' : '応募者電話番号を取得できませんでした';
          console.log(`応募者へのSMS/RCS送信をスキップしました (${detail})`);
          await notifySmsResult({
            to: applicantTel || '(no phone)',
            status: 'SKIPPED',
            detail,
          });
        }

        const timestamp = formatTimestampJST();
        await page.screenshot({
          path: `screenshots/recruit/pokepara_entry_${timestamp}.png`,
          fullPage: true,
        });

        console.log(`リンクを正常に開きました: ${targetLink}`);
        console.log(`スクリーンショットを保存しました: screenshots/recruit/pokepara_entry_${timestamp}.png`);

        await connection.addFlags(message.attributes.uid, '\\Seen');
        console.log('メールを既読にマークしました');
      } catch (messageError) {
        const errorMsg = messageError instanceof Error ? messageError.message : String(messageError);
        console.error(`メール処理中にエラーが発生しました: ${errorMsg}`);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    console.error(`エラーが発生しました: ${errorMsg}`);
    console.error('スタックトレース:', errorStack);
    throw error;
  } finally {
    if (connection) {
      await connection.end();
      console.log('メールサーバーとの接続を閉じました');
    }
  }
});

async function getPreferredBody(connection, message) {
  const parts = imaps.getParts(message.attributes.struct || []);

  const pickBodyPart = (preferredSubtype) =>
    parts.find((part) => {
      if (part.disposition) return false;
      const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
      const subtype = typeof part.subtype === 'string' ? part.subtype.toLowerCase() : '';
      return type === 'text' && subtype === preferredSubtype;
    });

  const bodyPart = pickBodyPart('html') || pickBodyPart('plain');

  if (!bodyPart) {
    throw new Error('メール本文のパートを特定できませんでした');
  }

  return connection.getPartData(message, bodyPart);
}

function extractPokeparaLinks(text) {
  if (!text) return [];

  const cleanText = String(text)
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ');

  const linkRegex =
    /https:\/\/www\.pokepara\.jp\/shopc_manage\/job\/list_detail\.(?:html|aspx)\?[^\s\n\r<>"']+/g;
  const matches = cleanText.match(linkRegex) || [];

  return matches.map((link) => link.replace(/[。、，,\])}]+$/g, ''));
}

function extractPokeparaMessageId(url) {
  try {
    return new URL(url).searchParams.get('mes_id') || '';
  } catch {
    return '';
  }
}

function extractPokeparaCompanyName(text) {
  const plainText = String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\u00a0/g, ' ');
  const lines = plainText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(.+?)様(?:\s|$)/);
    if (!match) {
      continue;
    }

    const candidate = match[1].trim();
    if (
      candidate &&
      !candidate.includes('求人応募') &&
      !candidate.includes('メッセージ') &&
      !candidate.includes('応募')
    ) {
      return candidate;
    }
  }

  const fallback = plainText.match(/([^\n\r]+?)様/);
  return fallback?.[1]?.trim() || '';
}

async function extractPokeparaApplicantContact(page) {
  await page.locator('#table_list').waitFor({ state: 'visible', timeout: 15000 });

  return page.locator('#table_list tr').evaluateAll((rows) => {
    const pageText = document.body.innerText || '';
    const companyName = extractCompanyNameFromText(pageText);

    for (const row of rows) {
      const title = row.querySelector('.title')?.textContent?.trim() || '';
      if (title !== '求人応募') {
        continue;
      }

      const message = row.querySelector('.message');
      const messageText = (message instanceof HTMLElement ? message.innerText : message?.textContent || '')
        .replace(/\u00a0/g, ' ')
        .trim();

      const application = extractApplicationFields(messageText);
      const applicantName = application.name;
      const mailtoHref = row.querySelector('.message a[href^="mailto:"]')?.getAttribute('href') || '';
      const mailtoEmail = mailtoHref.replace(/^mailto:/i, '').split('?')[0].trim();
      const textEmail = messageText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
      const applicantEmail = mailtoEmail || textEmail;

      const contactBlock = messageText.match(/■連絡先\s*([\s\S]*?)(?:\n?■|$)/)?.[1] || '';
      const telMatch = contactBlock.match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/);
      const applicantTel = telMatch?.[0]?.replace(/\s+/g, '') || '';

      return { applicantEmail, applicantTel, applicantName, application, companyName };
    }

    return { applicantEmail: '', applicantTel: '', applicantName: '', application: {}, companyName };

    function extractApplicationFields(text) {
      return {
        name: extractField(text, '名前'),
        age: extractField(text, '年齢'),
        gender: extractField(text, '性別'),
        address: extractField(text, '住所'),
        contact: extractField(text, '連絡先'),
        preferredReplyMethod: extractField(text, '希望返信方法'),
        workExperience: extractField(text, 'お仕事経験'),
        interviewPreferredDate: extractField(text, '面接希望日'),
        selfPr: extractField(text, '自己PR・問合せ内容'),
        rawMessage: text,
      };
    }

    function extractField(text, label) {
      return text.match(new RegExp(`■${escapeRegExp(label)}\\s*([\\s\\S]*?)(?:\\n?■|$)`))?.[1]?.trim() || '';
    }

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractCompanyNameFromText(text) {
      const lines = String(text || '')
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        const match = line.match(/^(.+?)様(?:\s|$)/);
        if (!match) {
          continue;
        }

        const candidate = match[1].trim();
        if (
          candidate &&
          !candidate.includes('求人応募') &&
          !candidate.includes('メッセージ') &&
          !candidate.includes('応募')
        ) {
          return candidate;
        }
      }

      const fallback = String(text || '').match(/([^\n\r]+?)様/);
      return fallback?.[1]?.trim() || '';
    }
  });
}

function formatTimestampJST() {
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(new Date());
  const values: Record<string, string> = {};

  for (const part of parts) {
    if (part.type === 'literal') continue;
    values[part.type] = part.value;
  }

  const safe = (key, fallback) => (values[key] && values[key].padStart(2, '0')) || fallback;

  return `${safe('year', '0000')}-${safe('month', '00')}-${safe('day', '00')}_${safe('hour', '00')}-${safe('minute', '00')}-${safe('second', '00')}`;
}

async function notifyRecruitProspectSafely(params) {
  try {
    await notifyRecruitProspectMessageEvent(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`recruit-nomi-hub連携に失敗しました: ${message}`);
  }
}
