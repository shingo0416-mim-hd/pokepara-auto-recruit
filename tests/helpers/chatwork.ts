import https, { RequestOptions } from 'https';
import querystring from 'querystring';

interface ChatworkConfig {
  enabled: boolean;
  apiToken: string;
  roomId: string;
}

let chatworkConfig: ChatworkConfig = {
  enabled: String(process.env.CHATWORK_ENABLED ?? 'true') === 'true',
  apiToken: process.env.CHATWORK_API_TOKEN ?? '',
  roomId: process.env.CHATWORK_ROOM_ID ?? '',
};

export function setChatworkConfig(config: Partial<ChatworkConfig>): void {
  chatworkConfig = {
    enabled: typeof config.enabled === 'boolean' ? config.enabled : chatworkConfig.enabled,
    apiToken: typeof config.apiToken === 'string' ? config.apiToken : chatworkConfig.apiToken,
    roomId: typeof config.roomId === 'string' ? config.roomId : chatworkConfig.roomId,
  };
}

type ResultStatus = 'SUCCESS' | 'FAIL' | 'SKIPPED';

export function sendChatworkMessage(body: string): Promise<void> {
  const { enabled, apiToken, roomId } = chatworkConfig;

  if (!enabled) {
    return Promise.resolve();
  }

  if (!apiToken || !roomId) {
    return Promise.reject(new Error('Chatwork設定(api_token/room_id)が未取得のため送信できません'));
  }

  const postData = querystring.stringify({ body });
  const options: RequestOptions = {
    hostname: 'api.chatwork.com',
    port: 443,
    path: `/v2/rooms/${encodeURIComponent(roomId)}/messages`,
    method: 'POST',
    headers: {
      'X-ChatWorkToken': apiToken,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode && Math.floor(res.statusCode / 100) === 2) {
        res.on('data', () => undefined);
        res.on('end', resolve);
      } else {
        let chunks = '';
        res.on('data', (c) => {
          chunks += c;
        });
        res.on('end', () => {
          reject(new Error(`Chatwork API エラー: ${res.statusCode ?? 'N/A'} ${chunks || ''}`));
        });
      }
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

export interface EmailResultParams {
  to: string;
  subject: string;
  status: ResultStatus;
  detail?: string;
  emailBody?: string;
}

export async function notifyEmailResult({ to, subject, status, detail, emailBody }: EmailResultParams): Promise<void> {
  const icon = status === 'SUCCESS' ? '✅' : status === 'SKIPPED' ? '⏭️' : '❌';
  let message =
    `[メール送信結果] ${icon}\n` +
    `宛先: ${to}\n` +
    `件名: ${subject}\n` +
    `ステータス: ${status}\n` +
    (detail ? `詳細: ${detail}\n` : '');

  const trimmedEmailBody = typeof emailBody === 'string' ? emailBody.trim() : '';
  if (trimmedEmailBody) {
    message += `\n---\n本文:\n${trimmedEmailBody}\n`;
  }

  await sendChatworkMessage(message);
}

export interface SmsResultParams {
  to: string;
  status: ResultStatus;
  detail?: string;
  smsBody?: string;
}

export async function notifySmsResult({ to, status, detail, smsBody }: SmsResultParams): Promise<void> {
  const icon = status === 'SUCCESS' ? '✅' : status === 'SKIPPED' ? '⏭️' : '❌';
  let body =
    `[SMS送信結果] ${icon}\n` +
    `宛先: ${to}\n` +
    `ステータス: ${status}\n` +
    (detail ? `詳細: ${detail}\n` : '');

  const trimmedSmsBody = typeof smsBody === 'string' ? smsBody.trim() : '';
  if (trimmedSmsBody) {
    body += `\n---\n本文:\n${trimmedSmsBody}\n`;
  }

  await sendChatworkMessage(body);
}
