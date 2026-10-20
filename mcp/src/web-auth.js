import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char,
  );
}

function page(title, content) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · OpenGym MCP</title><link rel="stylesheet" href="/auth.css"><script src="/auth.js" defer></script><main><p class="brand">OpenGym MCP</p><h1>${title}</h1>${content}<p id="error" role="alert"></p></main></html>`,
    {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
}

const script = `
const error = document.querySelector('#error');
async function send(path, body) {
  const response = await fetch('/api/auth' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error_description || 'Could not complete the request. Try again.');
  return data;
}
document.querySelector('form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const form = event.currentTarget;
  const oauthQuery = form.elements.oauth_query?.value;
  error.textContent = '';
  for (const item of form.querySelectorAll('button')) item.disabled = true;
  try {
    let data;
    if (form.dataset.action === 'consent') {
      data = await send('/oauth2/consent', { accept: button.value === 'accept', oauth_query: oauthQuery });
    } else if (form.dataset.action === 'disconnect') {
      await send('/disconnect-opengym', {});
      await send('/sign-out', {});
      location.assign('/sign-in'); return;
    } else if (form.dataset.action === 'sign-out') {
      await send('/sign-out', {});
      location.assign('/'); return;
    } else {
      data = await send('/sign-in/opengym', { code: form.elements.code.value.trim(), ...(oauthQuery ? { oauth_query: oauthQuery } : {}) });
    }
    const destination = data.url || data.redirect_uri;
    if (!destination) throw new Error('The authorization response did not include a redirect. Start again.');
    location.assign(destination);
  } catch (failure) {
    error.textContent = failure.message;
    for (const item of form.querySelectorAll('button')) item.disabled = false;
  }
});
`;

export function createWebAuth(runtime) {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method !== 'GET') return;
    if (url.pathname === '/auth.js')
      return new Response(script, {
        headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
      });
    if (url.pathname === '/auth.css')
      return new Response(
        `:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111;color:#eee}body{margin:0;padding:24px}main{max-width:460px;margin:12vh auto;padding:32px;border:1px solid #333;border-radius:16px;background:#191919}h1{font-size:28px}.brand{color:#a3e635;font-weight:700}p{line-height:1.6}button{padding:12px 20px;border:0;border-radius:24px;background:#a3e635;color:#111;font:inherit;font-weight:650;cursor:pointer;margin:8px 8px 0 0}button[value=deny]{background:#333;color:#eee}button:disabled{opacity:.5}#error{color:#ffaaa0;overflow-wrap:anywhere}code{overflow-wrap:anywhere}`,
        { headers: { 'Content-Type': 'text/css; charset=utf-8' } },
      );
    if (!['/', '/sign-in', '/consent'].includes(url.pathname)) return;
    const query = url.search.slice(1);
    const oauthQuery = url.searchParams.has('sig') ? query : undefined;
    if (
      (oauthQuery || url.pathname === '/consent') &&
      !(await verifyOAuthQueryParams(
        query,
        (
          await runtime.auth.$context
        ).secret,
      ))
    ) {
      return new Response(
        'Invalid or expired authorization request. Start again from your MCP client.',
        { status: 400 },
      );
    }
    const session = await runtime.auth.api.getSession({
      headers: request.headers,
    });
    const hidden = oauthQuery
      ? `<input type="hidden" name="oauth_query" value="${escapeHtml(oauthQuery)}">`
      : '';
    if (url.pathname === '/consent') {
      if (!session)
        return new Response(
          'Your session expired. Start again from your MCP client.',
          { status: 401 },
        );
      return page(
        'Allow OpenGym access?',
        `<p>Signed in as <strong>${escapeHtml(session.user.name)}</strong>.</p><p>Client <code>${escapeHtml(url.searchParams.get('client_id') || '')}</code> is requesting:</p><p><code>${escapeHtml(url.searchParams.get('scope') || '')}</code></p><p>This permits reading, creating, changing and deleting your OpenGym training data and settings, and using server operations allowed by your account. Admin accounts also grant administrative access.</p><form data-action="consent">${hidden}<button value="accept">Allow access</button><button value="deny">Deny</button></form>`,
      );
    }
    if (session && url.pathname === '/') {
      return page(
        'OpenGym connected',
        `<p>Signed in as <strong>${escapeHtml(session.user.name)}</strong>. Connect your MCP client to <code>${escapeHtml(runtime.resource)}</code> using OAuth.</p><form data-action="disconnect"><button>Disconnect OpenGym</button></form>`,
      );
    }
    return page(
      'Connect OpenGym',
      `<p>Sign in to let your MCP client use your OpenGym account. Your connection belongs only to you.</p>${url.searchParams.has('error') ? '<p>OpenGym sign-in failed. Please try again.</p>' : ''}<p>In your signed-in OpenGym app, open Settings → Pair the mobile app. Enter the one-time code here within five minutes.</p><form data-action="sign-in">${hidden}<label>Pairing code <input name="code" required minlength="8" maxlength="8" autocomplete="off" spellcheck="false"></label><button>Connect OpenGym</button></form>`,
    );
  };
}
