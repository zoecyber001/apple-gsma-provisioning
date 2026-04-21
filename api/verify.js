// Vercel Serverless Function — proxies verification payloads to Discord
// Discord webhook URL is stored safely as env var: DISCORD_WEBHOOK

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) return res.status(500).json({ error: 'Webhook not configured' });

  try {
    const { embeds, image, filename } = req.body;

    if (image) {
      // Image payload — send as file attachment via multipart/form-data
      const buffer = Buffer.from(image, 'base64');
      const boundary = '----VerifyBoundary' + Date.now();

      let body = '';
      // Embed part
      if (embeds) {
        body += `--${boundary}\r\n`;
        body += 'Content-Disposition: form-data; name="payload_json"\r\n';
        body += 'Content-Type: application/json\r\n\r\n';
        body += JSON.stringify({ embeds }) + '\r\n';
      }

      // File part — build manually with Buffer for binary data
      const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename || 'capture.jpg'}"\r\nContent-Type: image/jpeg\r\n\r\n`;
      const fileFooter = `\r\n--${boundary}--\r\n`;

      const bodyBuffer = Buffer.concat([
        Buffer.from(body + fileHeader, 'utf-8'),
        buffer,
        Buffer.from(fileFooter, 'utf-8')
      ]);

      const discordRes = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: bodyBuffer
      });

      const status = discordRes.status;
      return res.status(status < 400 ? 200 : 502).json({ ok: status < 400 });
    } else {
      // Standard embed payload
      const discordRes = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds })
      });

      const status = discordRes.status;
      return res.status(status < 400 ? 200 : 502).json({ ok: status < 400 });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' });
  }
}
