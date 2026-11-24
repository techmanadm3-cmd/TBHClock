const fs = require('fs');
const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

class GoogleSheetsClient {
  constructor({ spreadsheetId, credentialsPath, credentialsJson }) {
    this.spreadsheetId = spreadsheetId;
    this.credentials = credentialsJson || JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      iss: this.credentials.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    }));
    const unsigned = `${header}.${payload}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), this.credentials.private_key).toString('base64url');
    const assertion = `${unsigned}.${signature}`;

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    });
    const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`Google token failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this.token;
  }

  async get(range) {
    const token = await this.accessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sheets GET ${range} failed ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.values || [];
  }

  async append(range, row) {
    const token = await this.accessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ majorDimension: 'ROWS', values: [row] })
    });
    if (!res.ok) throw new Error(`Sheets APPEND ${range} failed ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

module.exports = { GoogleSheetsClient };
