import nodemailer from "nodemailer";

export async function sendEmail({ to, subject, body }) {
  const settings = getEmailSettings();

  if (settings.dryRun) {
    return {
      ok: true,
      dryRun: true,
      provider: settings.provider,
      from: settings.from || settings.user || null,
      to,
      subject,
      message: "Email dry run completed. No email was sent."
    };
  }

  if (!settings.user || !settings.password) {
    return {
      ok: false,
      code: "email_not_configured",
      message:
        "Email sending is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env, then restart the server."
    };
  }

  const transporter = nodemailer.createTransport({
    service: settings.provider,
    auth: {
      user: settings.user,
      pass: settings.password
    }
  });

  const info = await transporter.sendMail({
    from: settings.from || settings.user,
    to,
    subject,
    text: body
  });

  return {
    ok: true,
    dryRun: false,
    provider: settings.provider,
    from: settings.from || settings.user,
    to,
    subject,
    messageId: info.messageId,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
    message: "Email sent."
  };
}

function getEmailSettings() {
  return {
    provider: process.env.EMAIL_PROVIDER || "gmail",
    user: process.env.GMAIL_USER || process.env.EMAIL_USER || null,
    password: process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_PASSWORD || null,
    from: process.env.EMAIL_FROM || null,
    dryRun: process.env.EMAIL_DRY_RUN !== "false"
  };
}
