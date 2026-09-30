import type { Page } from '@playwright/test';

export async function extractPokeparaApplicantContact(page: Page) {
  await page.locator('#table_list').waitFor({ state: 'visible', timeout: 15000 });

  return page.locator('#table_list tr').evaluateAll((rows) => {
    const pageText = document.body.innerText || '';
    const companyName = extractCompanyNameFromText(pageText);

    for (const row of rows) {
      const title = row.querySelector('.title')?.textContent?.trim() || '';
      // スタッフ求人など、応募種別が括弧で付いた見出しにも対応する。
      if (!/^求人応募(?:\s*[（(][^）)]+[）)])?$/.test(title)) {
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

    // 形式変更を空の連絡先として処理し、応募メールを既読にしない。
    throw new Error('応募詳細に求人応募の本文が見つかりません。ページの形式を確認してください。');

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

