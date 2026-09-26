// Cookie-based console session endpoints.

export interface Me {
  account_id: string;
  username: string;
  issuer: string;
  password_login?: boolean;
  signed_in_with?: "password" | "token";
}

export interface Options {
  dev_login: boolean;
  password_login: boolean;
}

export type Credential = { password: string } | { token: string } | { dev: true };

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

export async function options(): Promise<Options> {
  const response = await fetch("/console/api/options", { credentials: "same-origin" });
  if (!response.ok) return { dev_login: false, password_login: false };
  return json<Options>(response);
}

export async function login(credential: Credential): Promise<void> {
  await json(
    await fetch("/console/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    }),
  );
}

/** `current` is required when the session signed in with the password it replaces. */
export async function setPassword(current: string | null, password: string): Promise<void> {
  await json(
    await fetch("/console/api/password", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current === null ? { password } : { current, password }),
    }),
  );
}

export async function logout(): Promise<void> {
  await fetch("/console/api/logout", { method: "POST", credentials: "same-origin" });
}
