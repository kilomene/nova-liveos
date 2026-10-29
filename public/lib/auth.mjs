// Nova LiveOS auth — v1.0.5
// Supabase Auth over plain REST (zero dependencies, fetch only):
//   POST /auth/v1/signup                        email + password sign-up
//   POST /auth/v1/token?grant_type=password     sign-in
//   POST /auth/v1/otp                           magic-link email
//   POST /auth/v1/token?grant_type=refresh_token  session refresh
//   POST /auth/v1/logout                        sign-out
//   GET  /auth/v1/user                          current user
// Sessions persist in localStorage as { access_token, refresh_token,
// expires_at (ms epoch), user: { id, email } }. The adapter swaps its
// identity to the auth user id while a session lives, and records are
// written with created_by = that id; signed out, the shell falls back to
// the anonymous per-browser UUID exactly as v0.1 did.

import { fetchJson } from "./net.mjs";

export const SESSION_KEY = "liveos.session.v1";

export function displayNameFromEmail(email) {
  const name = String(email || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  return name ? name.replace(/\b\w/g, (c) => c.toUpperCase()) : "Member";
}

export function sessionFromAuthResponse(json, nowMs = Date.now()) {
  if (!json?.access_token || !json?.user?.id) return null;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || "",
    expires_at: nowMs + (Number(json.expires_in) || 3600) * 1000,
    user: { id: json.user.id, email: json.user.email || "" }
  };
}

export function parseStoredSession(raw) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s?.access_token || !s?.user?.id) return null;
    return s;
  } catch { return null; }
}

// Expired (or within `skewMs` of expiry) sessions should be refreshed
// before use; a failed refresh signs the shell back to anonymous mode.
export function isSessionExpired(session, nowMs = Date.now(), skewMs = 30_000) {
  if (!session?.expires_at) return true;
  return nowMs + skewMs >= session.expires_at;
}

export class AuthClient {
  constructor({ url, anonKey, storage = globalThis.localStorage, fetchOpts = {} }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.anonKey = anonKey || "";
    this.storage = storage;
    this.fetchOpts = fetchOpts;
    this.session = parseStoredSession(this.storage?.getItem(SESSION_KEY));
  }
  _save(session) {
    this.session = session;
    if (session) this.storage?.setItem(SESSION_KEY, JSON.stringify(session));
    else this.storage?.removeItem(SESSION_KEY);
  }
  _headers(extra = {}) {
    return { apikey: this.anonKey, "Content-Type": "application/json", ...extra };
  }
  async _call(path, { method = "POST", body, token } = {}) {
    const headers = this._headers(token ? { Authorization: `Bearer ${token}` } : {});
    return fetchJson(`${this.url}/auth/v1/${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }, this.fetchOpts);
  }
  async signUp(email, password) {
    const json = await this._call("signup", { body: { email, password } });
    const session = sessionFromAuthResponse(json);
    if (session) this._save(session);
    return { session, user: json?.user || session?.user || null, needsConfirmation: !session };
  }
  async signIn(email, password) {
    const json = await this._call("token?grant_type=password", { body: { email, password } });
    const session = sessionFromAuthResponse(json);
    if (!session) throw new Error("Sign-in did not return a session.");
    this._save(session);
    return session;
  }
  async signInWithMagicLink(email, redirectTo) {
    await this._call("otp", { body: { email, create_user: true, ...(redirectTo ? { email_redirect_to: redirectTo } : {}) } });
    return { sent: true };
  }
  async refresh() {
    if (!this.session?.refresh_token) throw new Error("No refresh token.");
    const json = await this._call("token?grant_type=refresh_token", { body: { refresh_token: this.session.refresh_token } });
    const session = sessionFromAuthResponse(json);
    if (!session) throw new Error("Refresh did not return a session.");
    this._save(session);
    return session;
  }
  // Use a valid session, refreshing first if it is expired/near expiry.
  // Returns null when signed out or unrecoverable (caller = anonymous).
  async validSession() {
    if (!this.session) return null;
    if (!isSessionExpired(this.session)) return this.session;
    try { return await this.refresh(); }
    catch { this._save(null); return null; }
  }
  async getUser() {
    const session = await this.validSession();
    if (!session) return null;
    const json = await fetchJson(`${this.url}/auth/v1/user`, {
      headers: this._headers({ Authorization: `Bearer ${session.access_token}` })
    }, this.fetchOpts);
    return json?.id ? { id: json.id, email: json.email || "" } : null;
  }
  async signOut() {
    const token = this.session?.access_token;
    this._save(null);
    if (token) {
      try { await this._call("logout", { token }); } catch { /* already gone locally */ }
    }
  }
  // Magic-link callbacks land in the URL hash (#access_token=…&refresh_token=…)
  // which collides with the shell's hash router — the shell calls this at
  // boot, BEFORE routing, and cleans the hash when a session was captured.
  captureCallbackHash(hash = "") {
    if (!hash.includes("access_token=")) return null;
    const params = new URLSearchParams(hash.replace(/^#\/?/, ""));
    const access = params.get("access_token");
    const refresh = params.get("refresh_token");
    const expiresIn = Number(params.get("expires_in")) || 3600;
    if (!access) return null;
    // The user id is inside the JWT's sub claim.
    let sub = "";
    try {
      const payload = JSON.parse(atob(access.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      sub = payload.sub || "";
    } catch { /* opaque token: getUser() will resolve it */ }
    const session = {
      access_token: access, refresh_token: refresh || "",
      expires_at: Date.now() + expiresIn * 1000,
      user: { id: sub, email: "" }
    };
    this._save(session);
    return session;
  }
}
