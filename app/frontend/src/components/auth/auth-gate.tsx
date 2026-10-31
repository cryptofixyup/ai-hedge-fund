import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

type SessionState = 'checking' | 'authenticated' | 'unauthenticated' | 'unavailable';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<SessionState>(import.meta.env.DEV ? 'authenticated' : 'checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const refreshSession = useCallback(async () => {
    if (import.meta.env.DEV) {
      setState('authenticated');
      return;
    }
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        setState('unavailable');
        return;
      }
      const result = await response.json() as { authenticated?: boolean };
      setState(result.authenticated ? 'authenticated' : 'unauthenticated');
    } catch {
      setState('unavailable');
    }
  }, []);

  useEffect(() => {
    void refreshSession();
    if (import.meta.env.DEV) return undefined;
    const handleFocus = () => void refreshSession();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshSession]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(response.status === 401 ? 'Invalid password.' : 'Authentication service rejected the request.');
        return;
      }
      setPassword('');
      setState('authenticated');
    } catch {
      setError('Authentication service is unavailable.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogout() {
    setError('');
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setError('Could not end the session.');
        return;
      }
      setState('unauthenticated');
    } catch {
      setError('Authentication service is unavailable.');
    }
  }

  if (state === 'checking' || state === 'unavailable') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">AI Hedge Fund</h1>
          <p className="text-sm text-muted-foreground">
            {state === 'checking' ? 'Checking private access…' : 'The authentication service is unavailable.'}
          </p>
          {state === 'unavailable' && (
            <button className="w-full rounded-md border px-4 py-2 text-sm font-medium" onClick={() => void refreshSession()}>
              Retry
            </button>
          )}
        </section>
      </main>
    );
  }

  if (state === 'unauthenticated') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <form onSubmit={handleLogin} className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">AI Hedge Fund</h1>
            <p className="text-sm text-muted-foreground">Private access. Enter the owner password to continue.</p>
          </div>
          <label className="block space-y-2 text-sm font-medium" htmlFor="owner-password">
            Owner password
            <input
              id="owner-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={event => setPassword(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={submitting || password.length === 0}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <>
      {children}
      {!import.meta.env.DEV && (
        <div className="fixed bottom-3 right-3 z-[1000]">
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="rounded-md border bg-background/95 px-3 py-2 text-xs font-medium text-foreground shadow-sm backdrop-blur"
          >
            Sign out
          </button>
          {error && <p role="alert" className="mt-2 rounded-md bg-card px-3 py-2 text-xs text-destructive shadow">{error}</p>}
        </div>
      )}
    </>
  );
}
