import imaps from 'imap-simple';
import moment from 'moment-timezone';
import dotenv from 'dotenv';

dotenv.config();

const config = {
  imap: {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASS,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    authTimeout: 10000,
    connTimeout: 10000,
    keepalive: true,
    tlsOptions: {
      rejectUnauthorized: false,
    },
  },
};

export default async function getLatestAuthCode(
  loginTime: Date | null = null,
  maxRetries = 30,
  retryInterval = 2000,
): Promise<string> {
  const loginTimeJST = loginTime
    ? moment(loginTime).tz('Asia/Tokyo').format('YYYY-MM-DD HH:mm:ss JST')
    : '指定なし';
  console.log(`認証コード取得開始 - ログイン時刻: ${loginTimeJST}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`認証コード取得試行 ${attempt}/${maxRetries}`);

    try {
      const connection = await imaps.connect(config as any);
      await connection.openBox('INBOX');

      const searchStartTime = loginTime ?? new Date(Date.now() - 2 * 60 * 1000);
      const searchCriteria = ['UNSEEN', ['SINCE', searchStartTime]];
      const subjectSearchCriteria = ['UNSEEN', ['SINCE', searchStartTime], ['SUBJECT', '認証コードのご案内']];

      const fetchOptions = {
        bodies: ['HEADER'],
        markSeen: false,
        struct: true,
      };

      let messages;
      try {
        messages = await connection.search(subjectSearchCriteria, fetchOptions);
      } catch (error) {
        console.log('件名検索が失敗しました。従来の検索方法を使用します。');
        messages = await connection.search(searchCriteria, fetchOptions);
      }

      console.log(`検索結果: ${messages.length}件のメールが見つかりました`);

      const targetMessages = messages
        .map((item: any) => {
          const headerPart = item.parts.find((part: any) => part.which === 'HEADER');
          const subject = headerPart?.body?.subject?.[0] || '';
          const emailDate = new Date(headerPart?.body?.date?.[0] || 0);
          const emailDateJST = moment(emailDate).tz('Asia/Tokyo');
          const match = subject.match(/認証コードのご案内：(\d{6})/);

          console.log(`メール確認: 件名="${subject}", 受信時刻=${emailDateJST.format('YYYY-MM-DD HH:mm:ss JST')}`);

          if (match) {
            console.log(`認証コード候補発見: ${match[1]}`);

            if (loginTime) {
              const loginMoment = moment(loginTime).tz('Asia/Tokyo');
              console.log(
                `時刻比較: メール受信時刻=${emailDateJST.format('YYYY-MM-DD HH:mm:ss JST')}, ログイン時刻=${loginMoment.format('YYYY-MM-DD HH:mm:ss JST')}`,
              );

              const loginMomentWithBuffer = loginMoment.clone().subtract(10, 'seconds');

              if (emailDateJST.isBefore(loginMomentWithBuffer)) {
                console.log('ログイン時刻より前のメールのためスキップします');
                return null;
              }
              console.log('ログイン時刻以降のメールです - 採用します');
            }

            return { code: match[1], date: emailDate, uid: item.attributes.uid, dateJST: emailDateJST };
          }

          return null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => b.date - a.date);

      connection.end();

      if (targetMessages.length > 0) {
        const latestMessage = targetMessages[0];
        console.log(
          `認証コードを取得しました: ${latestMessage.code} (受信時刻: ${latestMessage.dateJST.format('YYYY-MM-DD HH:mm:ss JST')})`,
        );

        const markReadConnection = await imaps.connect(config as any);
        await markReadConnection.openBox('INBOX');
        await markReadConnection.addFlags(latestMessage.uid, '\\Seen');
        markReadConnection.end();

        return latestMessage.code;
      }

      console.log(`認証コードが見つかりませんでした。${retryInterval / 1000}秒後に再試行します...`);
    } catch (error) {
      const err = error as Error;
      console.error(`認証コード取得エラー (試行 ${attempt}): ${err.message}`);
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryInterval));
    }
  }

  throw new Error(`認証コードの取得に失敗しました。${maxRetries}回試行しましたが、認証コードが含まれるメールが見つかりませんでした。`);
}
