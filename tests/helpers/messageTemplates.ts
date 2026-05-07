export interface ApplicantTemplateParams {
  companyName?: string;
  applicantName?: string;
  applicantFurigana?: string;
  applicantAge?: number | string | null;
  applicantGender?: string | null;
  applicantOccupation?: string | null;
  jobAddress?: string;
  jobNumber?: string;
  jobName?: string;
  contactName?: string;
  contactTel?: string;
  interviewAddress?: string;
  companyUrl?: string;
  workplaceName?: string;
}

/** 応募者向けSMSメッセージのテンプレート行を生成 */
export function buildApplicantSmsMessageLines({
  companyName,
  applicantName,
  applicantFurigana,
}: ApplicantTemplateParams): string[] {
  const safeCompanyName = companyName || "採用担当";
  const safeApplicant = applicantFurigana || applicantName || "応募者様";

  return [
    `${safeApplicant}様、${safeCompanyName}採用担当です✨`,
    "",
    "面接の詳細については、公式LINEにてご案内しております😊",
    "",
    "👉 公式LINE(https://lin.ee/tvpRtOM)",
    "",
    "※こちらは送信専用です。返信なさらないようにご注意ください😢",
  ];
}
