from pathlib import Path
p=Path('src/components/SettingsModal.tsx')
s=p.read_text()
s=s.replace('''  const [oauthTokenURL, setOAuthTokenURL] = useState(server?.oauthTokenUrl ?? "");
  const [oauthClientID, setOAuthClientID] = useState("");''','''  const [oauthTokenURL, setOAuthTokenURL] = useState(server?.oauthTokenUrl ?? "");
  const [oauthAuthorizationURL, setOAuthAuthorizationURL] = useState(server?.oauthAuthorizationUrl ?? "");
  const [oauthClientID, setOAuthClientID] = useState("");''',1)
s=s.replace('''    setOAuthTokenURL(server?.oauthTokenUrl ?? "");
    setOAuthClientID("");''','''    setOAuthTokenURL(server?.oauthTokenUrl ?? "");
    setOAuthAuthorizationURL(server?.oauthAuthorizationUrl ?? "");
    setOAuthClientID("");''',1)
s=s.replace('''            oauthTokenUrl: oauthTokenURL.trim(),
            oauthClientId: oauthClientID.trim(),''','''            oauthTokenUrl: oauthTokenURL.trim(),
            oauthAuthorizationUrl: oauthAuthorizationURL.trim(),
            oauthClientId: oauthClientID.trim(),''',1)
s=s.replace('''oauthTokenUrl: oauthTokenURL.trim(), oauthClientId: oauthClientID.trim(), oauthClientSecret, oauthScopes: oauthScopes.trim(), oauthRefreshToken }),''','''oauthTokenUrl: oauthTokenURL.trim(), oauthAuthorizationUrl: oauthAuthorizationURL.trim(), oauthClientId: oauthClientID.trim(), oauthClientSecret, oauthScopes: oauthScopes.trim(), oauthRefreshToken }),''',1)
needle='''              <label className="panel-field">
                <span>OAuth client ID</span>'''
insert='''              <label className="panel-field">
                <span>OAuth authorization URL</span>
                <input value={oauthAuthorizationURL} onChange={(event) => setOAuthAuthorizationURL(event.target.value)} placeholder="https://auth.example.com/oauth/authorize" spellCheck={false} />
              </label>
'''
if needle not in s:
    raise SystemExit('oauth client ID needle missing')
s=s.replace(needle, insert+needle,1)
# Add authorize button before OAuth scopes field
needle='''              <label className="panel-field">
                <span>OAuth scopes</span>'''
insert='''              {server?.oauthConfigured && (
                <button type="button" className="btn btn-secondary" onClick={() => {
                  void backend.beginMCPOAuth(server.id).then((start) => {
                    window.open(start.url, "_blank", "noopener,noreferrer");
                    toast({ kind: "info", title: "OAuth opened", body: "Finish authorization in the browser; this window will pick up the new token." });
                  }).catch((cause: unknown) => {
                    toast({ kind: "error", title: "OAuth could not start", body: cause instanceof Error ? cause.message : "Try again." });
                  });
                }}>Authorize in browser</button>
              )}
'''
if needle not in s:
    raise SystemExit('oauth scopes needle missing')
s=s.replace(needle, insert+needle,1)
p.write_text(s)
