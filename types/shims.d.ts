declare module 'imap-simple' {
  const imapSimple: any;
  export default imapSimple;
}

declare module 'nodemailer/lib/mail-composer' {
  interface MailComposerOptions {
    from?: string;
    to?: string | string[];
    subject?: string;
    text?: string;
  }

  class MailComposer {
    constructor(options: MailComposerOptions);
    compile(): {
      build(callback: (err: Error | null, message?: Buffer) => void): void;
    };
  }

  export default MailComposer;
}
