import nodemailer, { Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { promisify } from 'util';
import { type ApplicantTemplateParams } from './messageTemplates';

interface ImapBox {
  attribs?: unknown[];
  children?: Record<string, ImapBox>;
  delim?: string;
}

interface ImapLike {
  append(source: Buffer, options: { mailbox: string; flags: string[] }, callback: (err: Error | null) => void): void;
  getBoxes(callback: (err: Error | null, boxes: Record<string, ImapBox>) => void): void;
}

export interface ImapSimpleConnection {
  imap: ImapLike;
}

export interface RecruitEmailDraftParams extends ApplicantTemplateParams {
  applicantEmail: string;
  subjectTemplate?: string;
  contentTemplate?: string;
  jobNumber?: string;
  contactName?: string;
  contactTel?: string;
  jobName?: string;
  jobAddress?: string;
  interviewAddress?: string;
  companyUrl?: string;
  workplaceName?: string;
}

export interface RecruitEmailDraft {
  to: string;
  subject: string;
  body: string;
  raw: string;
}

let mailTransporter: Transporter | null = null;
let mailCredentials: { user: string; pass: string } | null = null;

export function setMailCredentials({ user, pass }: { user: string; pass: string }): void {
  mailCredentials = { user, pass };
  mailTransporter = null; // reset transporter to pick up new creds
}

function requireMailCredentials(): { user: string; pass: string } {
  if (!mailCredentials?.user || !mailCredentials?.pass) {
    throw new Error('メール送信に必要な認証情報(user/pass)が設定されていません');
  }
  return mailCredentials;
}

export function buildRecruitEmailDraft({
  companyName,
  applicantName,
  applicantFurigana,
  applicantAge,
  applicantGender,
  applicantOccupation,
  applicantEmail,
  subjectTemplate,
  contentTemplate,
  jobNumber,
  contactName,
  contactTel,
  jobName,
  jobAddress,
  interviewAddress,
  companyUrl,
  workplaceName,
}: RecruitEmailDraftParams): RecruitEmailDraft {
  const safeCompanyName = companyName || '採用担当';
  const safeApplicant = applicantFurigana || applicantName || '';

  if (!subjectTemplate) {
    throw new Error('mail_settings.subject が未設定のためメール件名を生成できません');
  }
  if (!contentTemplate) {
    throw new Error('mail_settings.content が未設定のためメール本文を生成できません');
  }

  const subject = replaceTemplatePlaceholders(
    subjectTemplate,
    safeCompanyName,
    safeApplicant,
    applicantAge,
    applicantGender,
    applicantOccupation,
    jobNumber,
    contactName,
    contactTel,
    jobName,
    jobAddress,
    interviewAddress,
    companyUrl,
    workplaceName,
  );
  const body = replaceTemplatePlaceholders(
    contentTemplate,
    safeCompanyName,
    safeApplicant,
    applicantAge,
    applicantGender,
    applicantOccupation,
    jobNumber,
    contactName,
    contactTel,
    jobName,
    jobAddress,
    interviewAddress,
    companyUrl,
    workplaceName,
  );

  const raw = [`To: ${applicantEmail}`, `Subject: ${subject}`, '', body, ''].join('\n');

  return {
    to: applicantEmail,
    subject,
    body,
    raw,
  };
}

export async function saveRecruitEmailDraftToGmail({ connection, to, subject, body }: { connection: ImapSimpleConnection; to: string; subject: string; body: string; }): Promise<void> {
  if (!to) {
    throw new Error('送信先メールアドレスが空です');
  }

  if (!connection || !connection.imap) {
    throw new Error('有効なIMAP接続が利用できません');
  }

  const { user: from } = requireMailCredentials();
  if (!from) {
    throw new Error('メール送信者アドレスが設定されていません');
  }

  const rawMessage = await buildMimeMessage({ from, to, subject, body });
  await appendDraftToGmail({ imap: connection.imap, rawMessage });
}

export async function sendRecruitEmail({ to, subject, body }: { to: string; subject: string; body: string; }): Promise<void> {
  if (!to) {
    throw new Error('送信先メールアドレスが空です');
  }

  const transporter = getMailTransporter();
  const { user: from } = requireMailCredentials();

  await transporter.sendMail({
    from,
    to,
    subject,
    text: body,
  });
}

function getMailTransporter(): Transporter {
  if (mailTransporter) {
    return mailTransporter;
  }

  const { user, pass } = requireMailCredentials();

  mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user,
      pass,
    },
  });

  return mailTransporter;
}

async function buildMimeMessage({ from, to, subject, body }: { from: string; to: string; subject: string; body: string; }): Promise<Buffer> {
  const composer = new MailComposer({
    from,
    to,
    subject,
    text: body,
  });

  return new Promise((resolve, reject) => {
    composer.compile().build((err: Error | null, message: Buffer | undefined) => {
      if (err) {
        reject(err);
        return;
      }
      if (!message || !Buffer.isBuffer(message)) {
        reject(new Error('メールメッセージの生成に失敗しました'));
        return;
      }
      resolve(message);
    });
  });
}

async function appendDraftToGmail({ imap, rawMessage }: { imap: ImapLike; rawMessage: Buffer; }): Promise<void> {
  const appendAsync = promisify(
    (source: Buffer, options: { mailbox: string; flags: string[] }, callback: (err: Error | null) => void) =>
      imap.append(source, options, callback),
  ) as (source: Buffer, options: { mailbox: string; flags: string[] }) => Promise<void>;

  const mailbox = await resolveDraftMailbox(imap);
  await appendAsync(rawMessage, { mailbox, flags: ['\\Draft'] });
}

let cachedDraftMailbox: string | null = null;

async function resolveDraftMailbox(imap: ImapLike): Promise<string> {
  if (cachedDraftMailbox) {
    return cachedDraftMailbox;
  }

  const envMailbox = process.env.GMAIL_DRAFTS_MAILBOX;
  if (envMailbox) {
    cachedDraftMailbox = envMailbox;
    return cachedDraftMailbox;
  }

  const getBoxesAsync = promisify(imap.getBoxes.bind(imap)) as () => Promise<Record<string, ImapBox>>;

  try {
    const boxes = await getBoxesAsync();
    const found = findDraftMailbox(boxes, '', '/');
    if (found) {
      cachedDraftMailbox = found;
      return cachedDraftMailbox;
    }
  } catch (error) {
    console.warn('ドラフト用メールボックスの取得に失敗したため既定値を使用します', error);
  }

  cachedDraftMailbox = '[Gmail]/Drafts';
  return cachedDraftMailbox;
}

function findDraftMailbox(boxes: Record<string, ImapBox> | undefined, parentPath: string, fallbackDelim: string): string | null {
  for (const [name, box] of Object.entries(boxes ?? {})) {
    const delim = typeof box.delim === 'string' && box.delim.length > 0 ? box.delim : fallbackDelim;
    const currentPath = parentPath ? `${parentPath}${delim}${name}` : name;
    const attribs: string[] = [];
    if (Array.isArray(box.attribs)) {
      for (const attr of box.attribs) {
        const value = typeof attr === 'string' ? attr : String(attr ?? '');
        attribs.push(value.toUpperCase());
      }
    }

    if (attribs.includes('\\DRAFTS') || attribs.includes('DRAFTS')) {
      return currentPath;
    }

    if (box.children) {
      const childPath = findDraftMailbox(box.children, currentPath, delim || fallbackDelim);
      if (childPath) {
        return childPath;
      }
    }
  }

  return null;
}

function replaceTemplatePlaceholders(
  template: string,
  companyName: string,
  applicantName: string,
  applicantAge?: number | string | null,
  applicantGender?: string | null,
  applicantOccupation?: string | null,
  jobNumber?: string,
  contactName?: string,
  contactTel?: string,
  jobName?: string,
  jobAddress?: string,
  interviewAddress?: string,
  companyUrl?: string,
  workplaceName?: string,
): string {
  const replacements: Record<string, string> = {
    COMPANY: companyName || '',
    NAME: applicantName || '',
    AGE: typeof applicantAge === 'number' || typeof applicantAge === 'string' ? String(applicantAge) : '',
    GENDER: applicantGender || '',
    OCCUPATION: applicantOccupation || '',
    JOBNO: jobNumber || '',
    CONTACT: contactName || '',
    TEL: contactTel || '',
    JOBNAME: jobName || '',
    ADDRESS: jobAddress || '',
    INTERVIEW_ADDRESS: interviewAddress || '',
    COMPANY_URL: companyUrl || '',
    WORKPLACE: workplaceName || companyName || '',
  };

  let result = template;

  // Support both {{$KEY$}} and $KEY placeholder styles
  result = result.replace(/\{\{\s*\$([A-Z0-9_]+)\$\s*\}\}/gi, (_, key: string) => {
    const upper = key.toUpperCase();
    return Object.prototype.hasOwnProperty.call(replacements, upper) ? replacements[upper] : '';
  });

  result = result.replace(/\$([A-Z0-9_]+)/gi, (_, key: string) => {
    const upper = key.toUpperCase();
    return Object.prototype.hasOwnProperty.call(replacements, upper) ? replacements[upper] : '';
  });

  return result;
}
