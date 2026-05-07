import { Client as PgClient } from 'pg';

export interface BaitoruCredentials {
  loginMail: string;
  loginPassword: string;
}

export interface MailSettings {
  replyEmail: string;
  gmailAppKey: string;
  isActive: boolean;
  subject?: string | null;
  content?: string | null;
}

export interface ChatworkSettings {
  apiToken: string;
  roomId: string;
  isActive: boolean;
}

export interface SmsSettings {
  serviceType?: string | null;
  smsTitle?: string | null;
  apiToken?: string | null;
  apiClientId?: string | null;
  apiChatbotId?: string | null;
  apiTemplateId?: string | null;
  useTemplate?: boolean;
  apiType?: number | null;
  smsText?: string | null;
  rcsText?: string | null;
  apiCode?: string | null;
  isActive: boolean;
}

export interface StoreBroadcastAgeRange {
  broadcastAgeMin?: number | null;
  broadcastAgeMax?: number | null;
}

export interface StoreBroadcastCondition {
  gender?: string | null;
  ageMin?: number | null;
  ageMax?: number | null;
  excludedOccupations?: string[] | null;
}

interface PgOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: false | { rejectUnauthorized: boolean };
}

export function resolveTenantId(rawTenantId: string | number | undefined): number {
  const value = typeof rawTenantId === 'undefined' || rawTenantId === null ? '1' : String(rawTenantId);
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`BAITORU_TENANT_ID (or TENANT_ID) must be a positive integer. Received: ${value}`);
  }

  return parsed;
}

export async function fetchPrimaryBaitoruCredentials(tenantId: number): Promise<BaitoruCredentials> {
  const dbUrl = requireDbUrl();
  return fetchFromPostgres(dbUrl, tenantId);
}

export async function fetchMailSettings(tenantId: number): Promise<MailSettings> {
  const dbUrl = requireDbUrl();
  return fetchMailSettingsFromPostgres(dbUrl, tenantId);
}

export async function fetchChatworkSettings(tenantId: number): Promise<ChatworkSettings> {
  const dbUrl = requireDbUrl();
  return fetchChatworkSettingsFromPostgres(dbUrl, tenantId);
}

export async function fetchSmsSettings(tenantId: number): Promise<SmsSettings> {
  const dbUrl = requireDbUrl();
  return fetchSmsSettingsFromPostgres(dbUrl, tenantId);
}

export async function fetchStoreBroadcastAgeRange(tenantId: number, companyId: number): Promise<StoreBroadcastAgeRange | null> {
  const dbUrl = requireDbUrl();
  return fetchStoreBroadcastAgeRangeFromPostgres(dbUrl, tenantId, companyId);
}

export async function fetchStoreBroadcastConditions(tenantId: number, companyId: number): Promise<StoreBroadcastCondition[]> {
  const dbUrl = requireDbUrl();
  return fetchStoreBroadcastConditionsFromPostgres(dbUrl, tenantId, companyId);
}

async function fetchFromPostgres(dbUrl: string, tenantId: number): Promise<BaitoruCredentials> {
  const client = new PgClient(buildPgOptions(dbUrl));
  await client.connect();

  try {
    const query = `
      SELECT
        bc.login_email AS "loginMail",
        bc.login_password AS "loginPassword"
      FROM baitoru_credentials bc
      WHERE bc.tenant_id = $1 AND bc.is_primary = true
      ORDER BY bc.id ASC
      LIMIT 1;
    `;

    const result = await client.query(query, [tenantId]);
    const row = result.rows?.[0] as { loginMail?: string; loginPassword?: string } | undefined;

    if (!row?.loginMail || !row?.loginPassword) {
      throw new Error(`Primary baitoru_credentials not found for tenant_id=${tenantId}`);
    }

    return {
      loginMail: row.loginMail,
      loginPassword: row.loginPassword,
    };
  } finally {
    await client.end();
  }
}

async function fetchMailSettingsFromPostgres(dbUrl: string, tenantId: number): Promise<MailSettings> {
  const client = new PgClient(buildPgOptions(dbUrl));
  await client.connect();

  try {
    const query = `
      SELECT
        ms.reply_email AS "replyEmail",
        ms.gmail_app_key AS "gmailAppKey",
        ms.is_active AS "isActive",
        ms.subject AS "subject",
        ms.content AS "content"
      FROM mail_settings ms
      WHERE ms.tenant_id = $1
      ORDER BY ms.id ASC
      LIMIT 1;
    `;

    const result = await client.query(query, [tenantId]);
    const row = result.rows?.[0] as { replyEmail?: string; gmailAppKey?: string; isActive?: boolean; subject?: string | null; content?: string | null } | undefined;

    if (!row?.replyEmail || !row?.gmailAppKey || typeof row.isActive !== 'boolean') {
      throw new Error(`mail_settings (reply_email/gmail_app_key/is_active) not found for tenant_id=${tenantId}`);
    }

    return {
      replyEmail: row.replyEmail,
      gmailAppKey: row.gmailAppKey,
      isActive: row.isActive,
      subject: row.subject ?? undefined,
      content: row.content ?? undefined,
    };
  } finally {
    await client.end();
  }
}

async function fetchChatworkSettingsFromPostgres(dbUrl: string, tenantId: number): Promise<ChatworkSettings> {
  const client = new PgClient(buildPgOptions(dbUrl));
  await client.connect();

  try {
    const query = `
      SELECT
        cs.api_token AS "apiToken",
        cs.room_id AS "roomId",
        cs.is_active AS "isActive"
      FROM chatwork_settings cs
      WHERE cs.tenant_id = $1
      ORDER BY cs.id ASC
      LIMIT 1;
    `;

    const result = await client.query(query, [tenantId]);
    const row = result.rows?.[0] as { apiToken?: string; roomId?: string; isActive?: boolean } | undefined;

    if (!row?.apiToken || !row?.roomId || typeof row.isActive !== 'boolean') {
      throw new Error(`chatwork_settings (api_token/room_id/is_active) not found for tenant_id=${tenantId}`);
    }

    return {
      apiToken: row.apiToken,
      roomId: row.roomId,
      isActive: row.isActive,
    };
  } finally {
    await client.end();
  }
}

async function fetchSmsSettingsFromPostgres(dbUrl: string, tenantId: number): Promise<SmsSettings> {
  const client = new PgClient(buildPgOptions(dbUrl));
  await client.connect();

  try {
    const query = `
      SELECT
        ss.service_type AS "serviceType",
        ss.sms_title AS "smsTitle",
        ss.api_token AS "apiToken",
        ss.api_client_id AS "apiClientId",
        ss.api_chatbot_id AS "apiChatbotId",
        ss.api_template_id AS "apiTemplateId",
        ss.use_template AS "useTemplate",
        ss.api_type AS "apiType",
        ss.sms_text AS "smsText",
        ss.rcs_text AS "rcsText",
        ss.api_code AS "apiCode",
        ss.is_active AS "isActive"
      FROM sms_settings ss
      WHERE ss.tenant_id = $1
      ORDER BY ss.id ASC
      LIMIT 1;
    `;

    const result = await client.query(query, [tenantId]);
    const row = result.rows?.[0] as {
      serviceType?: string | null;
      smsTitle?: string | null;
      apiToken?: string | null;
      apiClientId?: string | null;
      apiChatbotId?: string | null;
      apiTemplateId?: string | null;
      useTemplate?: boolean;
      apiType?: number | null;
      smsText?: string | null;
      rcsText?: string | null;
      apiCode?: string | null;
      isActive?: boolean;
    } | undefined;

    if (!row || typeof row.isActive !== 'boolean') {
      throw new Error(`sms_settings (sms_text/rcs_text/is_active) not found for tenant_id=${tenantId}`);
    }

    return {
      serviceType: row.serviceType ?? undefined,
      smsTitle: row.smsTitle ?? undefined,
      apiToken: row.apiToken ?? undefined,
      apiClientId: row.apiClientId ?? undefined,
      apiChatbotId: row.apiChatbotId ?? undefined,
      apiTemplateId: row.apiTemplateId ?? undefined,
      useTemplate: !!row.useTemplate,
      apiType: row.apiType ?? undefined,
      smsText: row.smsText ?? undefined,
      rcsText: row.rcsText ?? undefined,
      apiCode: row.apiCode ?? undefined,
      isActive: row.isActive,
    };
  } finally {
    await client.end();
  }
}

async function fetchStoreBroadcastAgeRangeFromPostgres(dbUrl: string, tenantId: number, companyId: number): Promise<StoreBroadcastAgeRange | null> {
  const client = new PgClient(buildPgOptions(dbUrl));
  await client.connect();

  try {
    const query = `
      SELECT
        s.broadcast_age_min AS "broadcastAgeMin",
        s.broadcast_age_max AS "broadcastAgeMax"
      FROM stores s
      WHERE s.tenant_id = $1 AND s.company_id = $2
      ORDER BY s.id ASC
      LIMIT 1;
    `;

    const result = await client.query(query, [tenantId, companyId]);
    const row = result.rows?.[0] as { broadcastAgeMin?: number | null; broadcastAgeMax?: number | null } | undefined;

    if (!row) {
      return null;
    }

    return {
      broadcastAgeMin: typeof row.broadcastAgeMin === 'number' ? row.broadcastAgeMin : null,
      broadcastAgeMax: typeof row.broadcastAgeMax === 'number' ? row.broadcastAgeMax : null,
    };
  } finally {
    await client.end();
  }
}

async function fetchStoreBroadcastConditionsFromPostgres(dbUrl: string, tenantId: number, companyId: number): Promise<StoreBroadcastCondition[]> {
  const client = new PgClient(buildPgOptions(dbUrl));
  await client.connect();

  try {
    const query = `
      SELECT
        sbc.gender AS "gender",
        sbc.age_min AS "ageMin",
        sbc.age_max AS "ageMax",
        sbc.excluded_occupations AS "excludedOccupations"
      FROM store_broadcast_conditions sbc
      INNER JOIN stores s ON s.id = sbc.store_id
      WHERE s.tenant_id = $1 AND s.company_id = $2
      ORDER BY sbc.id ASC;
    `;

    const result = await client.query(query, [tenantId, companyId]);
    const rows = (result.rows || []) as {
      gender?: string | null;
      ageMin?: number | null;
      ageMax?: number | null;
      excludedOccupations?: unknown;
    }[];

    return rows.map((row) => ({
      gender: row.gender ?? null,
      ageMin: typeof row.ageMin === 'number' ? row.ageMin : null,
      ageMax: typeof row.ageMax === 'number' ? row.ageMax : null,
      excludedOccupations: parseExcludedOccupations(row.excludedOccupations),
    }));
  } finally {
    await client.end();
  }
}

function parseExcludedOccupations(value: unknown): string[] | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    const trimmed = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const trimmed = parsed
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean);
        return trimmed.length > 0 ? trimmed : null;
      }
    } catch {
      // ignore JSON parse errors and treat as no excluded occupations
    }
  }
  return null;
}

function requireDbUrl(): string {
  const dbUrl = process.env.DB_URL;
  if (dbUrl) {
    return dbUrl;
  }

  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const database = process.env.DB_DATABASE;
  const user = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;

  if (host && port && database && user && typeof password === 'string') {
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
  }

  throw new Error('DB_URL is not set. Provide the PostgreSQL connection string (e.g., postgres://user:pass@host:5432/dbname).');
}

function buildPgOptions(dbUrl: string): PgOptions {
  const url = new URL(dbUrl);
  const sslModeFromUrl = url.searchParams.get('sslmode')?.toLowerCase();
  const envSslDisable = String(process.env.DB_SSL_DISABLE ?? '').toLowerCase() === 'true';
  const envSslEnable = String(process.env.DB_SSL ?? '').toLowerCase() === 'true';

  const sslDisabledByUrl = sslModeFromUrl === 'disable';
  const sslRequiredByUrl = sslModeFromUrl && sslModeFromUrl !== 'disable';
  const isRds = url.hostname.endsWith('rds.amazonaws.com');

  let ssl: PgOptions['ssl'];

  if (envSslDisable || sslDisabledByUrl) {
    ssl = false;
  } else if (envSslEnable || sslRequiredByUrl || isRds) {
    ssl = { rejectUnauthorized: false };
  } else {
    ssl = false; // default: no SSL
  }

  // If full URL is provided, use connectionString; otherwise fall back to discrete env values.
  if (process.env.DB_URL) {
    return { connectionString: dbUrl, ssl };
  }

  const host = process.env.DB_HOST || url.hostname;
  const port = Number.parseInt(process.env.DB_PORT || url.port || '5432', 10);
  const user = process.env.DB_USERNAME || decodeURIComponent(url.username);
  const password = process.env.DB_PASSWORD ?? decodeURIComponent(url.password);
  const database = process.env.DB_DATABASE || url.pathname.replace(/^\//, '') || undefined;

  return { host, port, user, password, database, ssl };
}
