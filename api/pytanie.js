// POST /api/pytanie
// Question-form handler for the Fundamenty landing page. Syncs the
// contact into ActiveCampaign, stores the question in a custom field,
// and tags the contact so the question shows up in an AC automation.
//
// AC_API_URL and AC_API_KEY are read from process.env (set in Vercel) -
// never hardcode them here.

const TAG_NAME = 'fundamenty-pytanie';
const QUESTION_FIELD_ID = '2';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

async function acFetch(baseUrl, path, apiKey, options = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Api-Token': apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imie, email, pytanie, honeypot } = readBody(req);

  // Honeypot: real users never fill this hidden field in.
  if (honeypot) {
    return res.status(400).json({ error: 'Nieprawidłowe zgłoszenie.' });
  }

  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Nieprawidłowy adres e-mail.' });
  }

  const AC_API_URL = process.env.AC_API_URL;
  const AC_API_KEY = process.env.AC_API_KEY;
  if (!AC_API_URL || !AC_API_KEY) {
    console.error('pytanie: missing AC_API_URL or AC_API_KEY env vars');
    return res.status(500).json({ error: 'Błąd konfiguracji serwera.' });
  }

  try {
    // 1) Create or update the contact, storing the question in a custom field.
    const syncRes = await acFetch(AC_API_URL, '/api/3/contact/sync', AC_API_KEY, {
      method: 'POST',
      body: JSON.stringify({
        contact: {
          email: email.trim(),
          firstName: typeof imie === 'string' ? imie.trim() : '',
          fieldValues: [{ field: QUESTION_FIELD_ID, value: typeof pytanie === 'string' ? pytanie : '' }],
        },
      }),
    });
    if (!syncRes.ok) {
      console.error('pytanie: contact/sync failed', syncRes.status);
      return res.status(502).json({ error: 'Nie udało się zapisać zgłoszenia.' });
    }
    const syncData = await syncRes.json();
    const contactId = syncData && syncData.contact && syncData.contact.id;
    if (!contactId) {
      console.error('pytanie: contact/sync returned no contact id');
      return res.status(502).json({ error: 'Nie udało się zapisać zgłoszenia.' });
    }

    // 2) Look up the tag id - never create the tag, only use it if it exists.
    const tagRes = await acFetch(
      AC_API_URL,
      `/api/3/tags?search=${encodeURIComponent(TAG_NAME)}`,
      AC_API_KEY,
      { method: 'GET' }
    );
    if (!tagRes.ok) {
      console.error('pytanie: tag search failed', tagRes.status);
      return res.status(502).json({ error: 'Nie udało się zapisać zgłoszenia.' });
    }
    const tagData = await tagRes.json();
    const tag = ((tagData && tagData.tags) || []).find((t) => t.tag === TAG_NAME);
    if (!tag) {
      console.error(`pytanie: tag "${TAG_NAME}" not found in ActiveCampaign`);
      return res.status(500).json({ error: `Brak tagu "${TAG_NAME}" w ActiveCampaign.` });
    }

    // 3) Assign the tag to the contact. AC returns 422 if it's already
    // assigned - that's not a failure, just treat it as done.
    const contactTagRes = await acFetch(AC_API_URL, '/api/3/contactTags', AC_API_KEY, {
      method: 'POST',
      body: JSON.stringify({ contactTag: { contact: contactId, tag: tag.id } }),
    });
    if (!contactTagRes.ok && contactTagRes.status !== 422) {
      console.error('pytanie: contactTags failed', contactTagRes.status);
      return res.status(502).json({ error: 'Nie udało się zapisać zgłoszenia.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    // Log only the error type/message, never the request body (question text).
    console.error('pytanie: unexpected error', err && err.message);
    return res.status(500).json({ error: 'Coś poszło nie tak.' });
  }
};
