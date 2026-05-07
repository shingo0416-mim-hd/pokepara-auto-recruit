import axios, { AxiosInstance } from 'axios';
import { type SmsSettings } from './db';

let smsClient: AxiosInstance | null = null;
let rcsClient: AxiosInstance | null = null;

export function getSmsClient(): AxiosInstance {
  if (smsClient) {
    return smsClient;
  }

  const host = process.env.NTT_CPAAS_BASE_HOST;
  const apiKey = process.env.NTT_CPAAS_API_KEY;
  const scheme = (process.env.NTT_CPAAS_AUTH_SCHEME || 'App').toLowerCase();
  const timeout = Number(process.env.NTT_CPAAS_TIMEOUT_MS || 15000);

  if (!host || !apiKey) {
    throw new Error('NTT_CPAAS_BASE_HOST / NTT_CPAAS_API_KEY が未設定です。');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (scheme === 'x-api-key') {
    headers['x-api-key'] = apiKey;
  } else if (scheme === 'basic') {
    headers.Authorization = `Basic ${apiKey}`;
  } else if (scheme === 'bearer') {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers.Authorization = `App ${apiKey}`;
  }

  smsClient = axios.create({
    baseURL: `https://${host}`,
    timeout,
    headers,
    maxRedirects: 20,
  });

  return smsClient;
}

export function getRcsClient(): AxiosInstance {
  if (rcsClient) {
    return rcsClient;
  }

  const timeout = Number(process.env.NTT_CPAAS_TIMEOUT_MS || 15000);

  rcsClient = axios.create({
    baseURL: 'https://richrcs-api.serv.aixmsg.com',
    timeout,
    headers: {
      'Content-Type': 'application/json',
    },
    maxRedirects: 5,
  });

  return rcsClient;
}

export function normalizePhoneNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const z2h = (s: string): string => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  const digits = z2h(raw).replace(/[^0-9+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('+')) {
    return `+${digits.slice(1).replace(/\D/g, '')}`;
  }
  if (/^0\d{9,10}$/.test(digits)) {
    return `+81${digits.slice(1)}`;
  }
  return `+${digits}`;
}

export interface SendSmsParams {
  to: string;
  body: string;
  sender?: string;
}

export async function sendSms({ to, body, sender }: SendSmsParams): Promise<void> {
  const client = getSmsClient();

  if (!to || !/^\+?[0-9]+$/.test(to)) {
    throw new Error('送信先電話番号が不正です。E.164形式（例: +819012345678）で指定してください。');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('SMS本文（body）が未設定または不正です。');
  }

  const effectiveSender = sender || process.env.NTT_CPAAS_DEFAULT_SENDER || 'InfoSMS';
  const endpointPath = '/sms/3/messages';
  const payload = {
    messages: [
      {
        sender: effectiveSender,
        destinations: [{ to }],
        content: { text: body },
      },
    ],
  };

  try {
    const { data, status } = await client.post(endpointPath, payload);
    const first = Array.isArray((data as any)?.messages) ? (data as any).messages[0] : null;
    const messageId = first?.messageId || (data as any)?.messageId || '(unknown)';
    console.log('NTT CPaaS: SMS送信成功', { status, to, messageId });
  } catch (error) {
    const err = error as any;
    console.error('NTT CPaaS: SMS送信エラー', {
      status: err?.response?.status ?? 'unknown',
      code: err?.code ?? 'unknown',
      message: err?.message ?? 'unknown',
      response: err?.response?.data ?? '(no body)',
      hint: 'Authorizationヘッダ（App/Basic/Bearer/x-api-key）と host, payload構造（sender/destinations/content.text）を確認してください。',
    });
    throw new Error(`NTT CPaaS のSMS送信に失敗しました: ${err?.message || '原因不明'}`);
  }
}

export interface SendAixMessageParams {
  settings: SmsSettings & { apiToken?: string; apiClientId?: string; apiChatbotId?: string };
  phoneNumber: string;
  bodyReplacements: {
    companyName?: string;
    applicantName?: string;
    jobNumber?: string;
    jobName?: string;
    jobAddress?: string;
    contactName?: string;
    contactTel?: string;
    interviewAddress?: string;
    companyUrl?: string;
    workplaceName?: string;
  };
}

export interface SendAixMessageResult {
  smsText?: string;
  rcsText?: string;
  apiType: number;
  useTemplate: boolean;
  apiTemplateId?: string;
}

export async function sendAixMessage({ settings, phoneNumber, bodyReplacements }: SendAixMessageParams): Promise<SendAixMessageResult> {
  const client = getRcsClient();
  const xToken = settings.apiToken;
  const clientId = settings.apiClientId;
  const botId = settings.apiChatbotId;
  const apiType = resolveApiType(settings);
  const sendTaskName = (settings.smsTitle || 'baitoru-send').slice(0, 50) || 'baitoru-send';

  if (!xToken || !clientId || !botId) {
    throw new Error('sms_settings に api_token/api_client_id/api_chatbot_id が設定されていません');
  }

  const domesticPhone = toDomesticPhone(phoneNumber);
  if (!domesticPhone) {
    throw new Error('宛先電話番号を国内形式(070/080/090/060/020 + 8桁)に変換できませんでした');
  }

  // decide text content
  const useTemplate = !!settings.useTemplate && !!settings.apiTemplateId;
  const smsText = settings.smsText ? replaceTemplatePlaceholders(settings.smsText, bodyReplacements) : undefined;
  const rcsText = settings.rcsText ? replaceTemplatePlaceholders(settings.rcsText, bodyReplacements) : undefined;

  if (useTemplate) {
    if (!settings.apiTemplateId) {
      throw new Error('テンプレート送信が指定されていますが api_template_id が空です');
    }
    if (!apiType) {
      throw new Error('テンプレート送信には api_type が必要です (1: RCS+SMS など)');
    }
  } else {
    if ((apiType === 1 || apiType === 4) && (!smsText || !rcsText)) {
      throw new Error('apiTypeが1または4の場合、smsTextとrcsTextの両方が必要です');
    }
    if (apiType === 2 && !rcsText) {
      throw new Error('apiType=2の場合、rcsTextが必要です');
    }
    if (apiType === 3 && !smsText) {
      throw new Error('apiType=3の場合、smsTextが必要です');
    }
  }

  const dest = [{ phoneNumber: domesticPhone }];
  const payload: any = {
    sendTaskName,
    apiType,
    dest,
  };

  if (useTemplate) {
    payload.templateId = settings.apiTemplateId;
  } else {
    if (smsText) payload.smsText = smsText;
    if (rcsText) payload.rcsText = rcsText;
  }

  const endpoint = `/${encodeURIComponent(clientId)}/${encodeURIComponent(botId)}/broadcasts/send`;
  try {
    console.log('AIX RCS/SMS request', {
      endpoint,
      apiType,
      useTemplate,
      hasSmsText: !!smsText,
      hasRcsText: !!rcsText,
      templateId: settings.apiTemplateId || null,
      serviceType: settings.serviceType || null,
    });
    const res = await client.post(endpoint, payload, {
      headers: {
        'x-token': xToken,
      },
    });
    console.log('AIX RCS/SMS send success', { status: res.status, to: domesticPhone });
    return { smsText, rcsText, apiType, useTemplate, apiTemplateId: settings.apiTemplateId || undefined };
  } catch (error: any) {
    const respCode = error?.response?.data?.code;
    const respMsg = error?.response?.data?.message;
    const detailParts = [
      error?.message || 'unknown',
      respCode ? `code=${respCode}` : '',
      respMsg ? `msg=${respMsg}` : '',
    ].filter(Boolean);
    console.error('AIX RCS/SMS send failed', {
      status: error?.response?.status ?? 'unknown',
      data: error?.response?.data ?? '(no body)',
      message: error?.message ?? 'unknown',
    });
    throw new Error(`AIX RCS/SMS送信に失敗しました: ${detailParts.join(' | ')}`);
  }
}

function resolveApiType(settings: SmsSettings): number {
  if (typeof settings.apiType === 'number' && settings.apiType > 0) {
    return settings.apiType;
  }

  const serviceType = (settings.serviceType || '').toLowerCase();
  const hasSms = !!settings.smsText;
  const hasRcs = !!settings.rcsText;

  // service_type が sms の場合は SMS のみ
  if (serviceType === 'sms') {
    return 3;
  }

  // テンプレ送信時: RCSのみ/またはRCS+SMS のどちらか。指定なければ RCSのみ優先
  if (settings.useTemplate) {
    return hasSms && hasRcs ? 1 : 2;
  }

  // テキスト送信時: 両方あれば RCS+SMS, 片方だけならそれに合わせる
  if (hasSms && hasRcs) return 1; // RCS+SMS
  if (hasRcs) return 2; // RCS only
  if (hasSms) return 3; // SMS only

  // 何も無ければ既定で RCS+SMS
  return 1;
}

function toDomesticPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('81') && digits.length === 12) {
    // 81 + 10 digits
    return '0' + digits.slice(2);
  }
  if (digits.startsWith('0') && (digits.length === 10 || digits.length === 11)) {
    return digits.length === 10 ? `0${digits.slice(1)}` : digits;
  }
  return null;
}

function replaceTemplatePlaceholders(template: string, params: SendAixMessageParams['bodyReplacements']): string {
  const replacements: Record<string, string> = {
    COMPANY: params.companyName || '',
    NAME: params.applicantName || '',
    JOBNO: params.jobNumber || '',
    JOBNAME: params.jobName || '',
    ADDRESS: params.jobAddress || '',
    CONTACT: params.contactName || '',
    TEL: params.contactTel || '',
    INTERVIEW_ADDRESS: params.interviewAddress || '',
    COMPANY_URL: params.companyUrl || '',
    WORKPLACE: params.workplaceName || params.companyName || '',
  };

  let result = template;

  // Support {{$KEY$}} style
  result = result.replace(/\{\{\s*\$([A-Z0-9_]+)\$\s*\}\}/gi, (_, key: string) => {
    const upper = key.toUpperCase();
    return Object.prototype.hasOwnProperty.call(replacements, upper) ? replacements[upper] : '';
  });

  // Also support plain $KEY style
  result = result.replace(/\$([A-Z0-9_]+)/gi, (_, key: string) => {
    const upper = key.toUpperCase();
    return Object.prototype.hasOwnProperty.call(replacements, upper) ? replacements[upper] : '';
  });

  return result;
}
