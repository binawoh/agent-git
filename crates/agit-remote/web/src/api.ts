// Cookie-based console session endpoints.

export interface Me {
  account_id: string;
  username: string;
  issuer: string;
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

export async function me(): Promise<Me | null> {
  const response = await fetch("/console/api/me", { credentials: "same-origin" });
  if (response.status === 401) return null;
  return json<Me>(response);
}

export async function login(token: string | null): Promise<void> {
  await json(
    await fetch("/console/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(token === null ? { dev: true } : { token }),
    }),
  );
}

/** Whether this server is a local test instance offering development sign-in. */
export async function devLogin(): Promise<boolean> {
  const response = await fetch("/console/api/options", { credentials: "same-origin" });
  return response.ok && Boolean((await response.json()).dev_login);
}

export async function logout(): Promise<void> {
  await fetch("/console/api/logout", { method: "POST", credentials: "same-origin" });
}
