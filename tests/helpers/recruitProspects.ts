import axios from 'axios';

export interface RecruitProspectMessageEventParams {
  tenantId: number;
  sourceType?: string;
  sourceJobNo?: string;
  sourceCompanyName?: string;
  applicantName?: string;
  applicantNameKana?: string;
  phone?: string;
  email?: string;
  channel: 'source' | 'mail' | 'sms' | 'rcs';
  deliveryType?: string;
  templateKey?: string;
  externalMessageId?: string;
  sentAt?: string;
  status?: string;
  payload?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function baseUrl(): string {
  return String(process.env.RECRUIT_PROSPECTS_API_BASE_URL || '').trim().replace(/\/$/, '');
}

function apiToken(): string {
  return String(process.env.RECRUIT_PROSPECTS_API_TOKEN || '').trim();
}

export async function notifyRecruitProspectMessageEvent(params: RecruitProspectMessageEventParams): Promise<void> {
  const urlBase = baseUrl();
  const token = apiToken();

  if (!urlBase || !token) {
    console.log('recruit prospects API連携をスキップします: RECRUIT_PROSPECTS_API_BASE_URL または RECRUIT_PROSPECTS_API_TOKEN が未設定です');
    return;
  }

  const url = `${urlBase}/api/recruit/prospects/message-events`;

  await axios.post(
    url,
    {
      tenant_id: params.tenantId,
      source_type: params.sourceType || '',
      source_job_no: params.sourceJobNo || '',
      source_company_name: params.sourceCompanyName || '',
      applicant_name: params.applicantName || '',
      applicant_name_kana: params.applicantNameKana || '',
      phone: params.phone || '',
      email: params.email || '',
      channel: params.channel,
      delivery_type: params.deliveryType || '',
      template_key: params.templateKey || '',
      external_message_id: params.externalMessageId || '',
      sent_at: params.sentAt || new Date().toISOString(),
      status: params.status || 'sent',
      payload: params.payload || {},
      meta: params.meta || {},
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.RECRUIT_PROSPECTS_API_TIMEOUT_MS || 15000),
    },
  );
}
