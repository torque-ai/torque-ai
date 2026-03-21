import { useState } from 'react';

export default function Login({ onLogin, needsSetup }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const endpoint = needsSetup ? '/api/auth/setup' : '/api/auth/login';
      const body = needsSetup
        ? { username, password, displayName: displayName || undefined }
        : { username, password };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.csrfToken) {
          window.__torqueCsrf = data.csrfToken;
        }
        onLogin();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Authentication failed');
      }
    } catch (err) {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-white">TORQUE</h1>
          <p className="text-slate-400 text-sm mt-1">
            {needsSetup ? 'Create Admin Account' : 'Task Orchestration Dashboard'}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-lg p-6">
          <label className="block text-sm font-medium text-slate-300 mb-2">Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="admin"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 mb-4"
            autoFocus
            autoComplete="username"
          />
          <label className="block text-sm font-medium text-slate-300 mb-2">Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="********"
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
          />
          {needsSetup && (
            <>
              <label className="block text-sm font-medium text-slate-300 mb-2 mt-4">Display Name (optional)</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Your Name"
                className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </>
          )}
          {error && <p className="text-red-400 text-sm mt-2">{error}</p>}
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-md font-medium transition-colors"
          >
            {loading ? (needsSetup ? 'Creating...' : 'Signing in...') : (needsSetup ? 'Create Account' : 'Sign In')}
          </button>
        </form>
      </div>
    </div>
  );
}
