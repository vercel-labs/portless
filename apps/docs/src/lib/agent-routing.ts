const PREVIEW_BOTS = /slackbot|discordbot/i;

export function isPreviewBot(userAgent: string): boolean {
  return PREVIEW_BOTS.test(userAgent);
}
