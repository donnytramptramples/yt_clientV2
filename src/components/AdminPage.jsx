import React, { useState, useEffect, useCallback } from 'react';
import { Shield, Users, Settings, LogOut, Trash2, RefreshCw, Eye, EyeOff, ChevronRight, ChevronLeft, Clock, Activity } from 'lucide-react';

function timeAgo(ts) {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SetupForm({ onSetup }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      onSetup();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-md p-8 rounded-2xl bg-gray-900 border border-gray-700 shadow-2xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="p-3 rounded-xl bg-red-500/20 border border-red-500/30">
            <Shield size={28} className="text-red-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Admin Setup</h1>
            <p className="text-sm text-gray-400">Set your admin password (one time only)</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <label className="block text-sm text-gray-400 mb-1">Admin Password</label>
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 pr-12 text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              placeholder="Min. 8 characters"
              required
            />
            <button type="button" onClick={() => setShow(s => !s)} className="absolute right-3 top-9 text-gray-400 hover:text-white">
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">Confirm Password</label>
            <input
              type={show ? 'text' : 'password'}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              placeholder="Repeat password"
              required
            />
          </div>

          {error && <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-yellow-300 text-sm">
            ⚠ This password cannot be changed after setup. Store it securely.
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-50"
          >
            {loading ? 'Setting up...' : 'Set Admin Password'}
          </button>
        </form>
      </div>
    </div>
  );
}

function LoginForm({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      onLogin();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-gray-900 border border-gray-700 shadow-2xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="p-3 rounded-xl bg-red-500/20 border border-red-500/30">
            <Shield size={28} className="text-red-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Admin Panel</h1>
            <p className="text-sm text-gray-400">Restricted access</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Username</label>
            <input
              type="text"
              value="admin"
              readOnly
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 text-gray-400 cursor-not-allowed"
            />
          </div>
          <div className="relative">
            <label className="block text-sm text-gray-400 mb-1">Password</label>
            <input
              type={show ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 pr-12 text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              placeholder="Admin password"
              required
            />
            <button type="button" onClick={() => setShow(s => !s)} className="absolute right-3 top-9 text-gray-400 hover:text-white">
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {error && <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 rounded-lg bg-red-600 hover:bg-red-500 text-white font-semibold transition-colors disabled:opacity-50"
          >
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  );
}

function UserWatchHistory({ userId, username, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/users/${userId}/watch-history`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => setData({ history: [] }))
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full" />
    </div>
  );

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors">
        <ChevronLeft size={18} /> Back to users
      </button>
      <h2 className="text-xl font-bold mb-2">Watch History</h2>
      <p className="text-gray-400 text-sm mb-6">User: <span className="text-white font-medium">{username}</span> — {data?.history?.length || 0} entries</p>

      {data?.history?.length === 0 ? (
        <p className="text-gray-500 text-center py-12">No watch history for this user yet.</p>
      ) : (
        <div className="space-y-2">
          {data.history.map((item) => (
            <div key={item.id} className="flex items-center gap-3 p-3 rounded-lg bg-gray-800 border border-gray-700">
              {item.thumbnail && (
                <img src={item.thumbnail} alt="" className="w-16 h-9 object-cover rounded flex-shrink-0 bg-gray-700" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.title}</p>
                <p className="text-xs text-gray-400 truncate">{item.channel}</p>
              </div>
              <div className="text-xs text-gray-500 flex-shrink-0 flex items-center gap-1">
                <Clock size={12} />
                {new Date(item.watched_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResetPasswordModal({ user, onClose }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 6) return setError('Min 6 characters');
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/admin/users/${user.id}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        credentials: 'include',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div className="w-full max-w-sm p-6 bg-gray-900 border border-gray-700 rounded-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-lg mb-1">Reset Password</h3>
        <p className="text-gray-400 text-sm mb-4">User: <span className="text-white">{user.username}</span></p>
        {done ? (
          <div className="text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm mb-4">
            Password reset. All sessions for this user have been invalidated.
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              placeholder="New password (min 6 chars)"
            />
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button type="submit" disabled={loading} className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-50">
              {loading ? 'Resetting...' : 'Set New Password'}
            </button>
          </form>
        )}
        <button onClick={onClose} className="w-full py-2 mt-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm">
          {done ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

function Dashboard({ onLogout }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('users');
  const [viewingUser, setViewingUser] = useState(null);
  const [settings, setSettings] = useState({ max_accounts: 1000, max_connections: 500 });
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');
  const [resetUser, setResetUser] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/users', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        setData(d);
        if (d.settings) setSettings({ max_accounts: d.settings.max_accounts, max_connections: d.settings.max_connections });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (userId) => {
    if (!window.confirm('Permanently delete this account and all its data?')) return;
    setDeletingId(userId);
    try {
      await fetch(`/api/admin/users/${userId}`, { method: 'DELETE', credentials: 'include' });
      load();
    } catch {}
    setDeletingId(null);
  };

  const handleSaveSettings = async () => {
    setSettingsSaving(true); setSettingsMsg('');
    try {
      const r = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
        credentials: 'include',
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setSettingsMsg('Settings saved successfully.');
    } catch (e) {
      setSettingsMsg('Error: ' + e.message);
    } finally {
      setSettingsSaving(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
    onLogout();
  };

  if (viewingUser) {
    return (
      <div className="min-h-screen bg-gray-950 text-white p-6">
        <UserWatchHistory
          userId={viewingUser.id}
          username={viewingUser.username}
          onBack={() => setViewingUser(null)}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="bg-gray-900 border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield size={22} className="text-red-400" />
          <span className="font-bold text-lg">Admin Panel</span>
          <span className="text-xs bg-red-500/20 text-red-400 border border-red-500/30 rounded-full px-2 py-0.5">Restricted</span>
        </div>
        <button onClick={handleLogout} className="flex items-center gap-2 text-sm text-gray-400 hover:text-red-400 transition-colors">
          <LogOut size={16} /> Logout
        </button>
      </header>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 border-b border-gray-800">
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-4">
            <div className="text-3xl font-bold text-white">{data.totalUsers}</div>
            <div className="text-sm text-gray-400 mt-1 flex items-center gap-1"><Users size={14} /> Total Accounts</div>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-4">
            <div className="text-3xl font-bold text-green-400">{data.connectedUsers}</div>
            <div className="text-sm text-gray-400 mt-1 flex items-center gap-1"><Activity size={14} /> Active (15m)</div>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-4">
            <div className="text-3xl font-bold text-blue-400">{data.settings?.max_accounts ?? '—'}</div>
            <div className="text-sm text-gray-400 mt-1">Account Limit</div>
          </div>
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-4">
            <div className="text-3xl font-bold text-purple-400">{data.settings?.max_connections ?? '—'}</div>
            <div className="text-sm text-gray-400 mt-1">Session Limit</div>
          </div>
        </div>
      )}

      <div className="flex border-b border-gray-800 px-6">
        {[
          { id: 'users', label: 'Users', icon: Users },
          { id: 'settings', label: 'Settings', icon: Settings },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === id ? 'border-red-500 text-red-400' : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            <Icon size={15} /> {label}
          </button>
        ))}
        <div className="ml-auto flex items-center py-3">
          <button onClick={load} disabled={loading} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="p-6">
        {tab === 'users' && (
          <div>
            {loading ? (
              <div className="flex items-center justify-center h-48">
                <div className="animate-spin w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full" />
              </div>
            ) : (
              <div className="space-y-2">
                {(data?.users || []).map(user => {
                  const isActive = user.last_seen && (Date.now() - user.last_seen) < 15 * 60 * 1000;
                  return (
                    <div key={user.id} className="flex items-center gap-4 p-4 bg-gray-900 rounded-xl border border-gray-700 hover:border-gray-600 transition-colors">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {user.username[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{user.username}</span>
                          {isActive && (
                            <span className="flex items-center gap-1 text-xs bg-green-500/20 text-green-400 border border-green-500/30 rounded-full px-2 py-0.5">
                              <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                              Online
                            </span>
                          )}
                        </div>
                        <div className="text-sm text-gray-400 truncate">{user.email}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-3 mt-1 flex-wrap">
                          <span>Joined {new Date(user.created_at).toLocaleDateString()}</span>
                          <span className="flex items-center gap-1"><Clock size={11} /> Last seen {timeAgo(user.last_seen)}</span>
                          <span className="flex items-center gap-1 text-blue-400/80">
                            <Users size={11} /> {user.sub_count ?? 0} subscription{user.sub_count !== 1 ? 's' : ''}
                          </span>
                          <span className="flex items-center gap-1 text-purple-400/80">
                            <Eye size={11} /> {user.watch_count ?? 0} watched
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          onClick={() => setViewingUser(user)}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-blue-600 text-gray-300 hover:text-white transition-colors border border-gray-700"
                        >
                          <Eye size={13} /> History <ChevronRight size={13} />
                        </button>
                        <button
                          onClick={() => setResetUser(user)}
                          className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-yellow-600 text-gray-300 hover:text-white transition-colors border border-gray-700"
                        >
                          Reset PW
                        </button>
                        <button
                          onClick={() => handleDelete(user.id)}
                          disabled={deletingId === user.id}
                          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-red-600 text-gray-400 hover:text-white transition-colors border border-gray-700 disabled:opacity-50"
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
                {data?.users?.length === 0 && (
                  <p className="text-gray-500 text-center py-12">No user accounts yet.</p>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'settings' && (
          <div className="max-w-md space-y-6">
            <div>
              <h3 className="font-semibold text-lg mb-4">Account Limits</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    Max Total Accounts <span className="text-gray-500">(current: {data?.totalUsers ?? '?'})</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={settings.max_accounts}
                    onChange={e => setSettings(s => ({ ...s, max_accounts: parseInt(e.target.value) || 1 }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-red-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">New registrations are blocked when this limit is reached.</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    Max Concurrent Connections
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={settings.max_connections}
                    onChange={e => setSettings(s => ({ ...s, max_connections: parseInt(e.target.value) || 1 }))}
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-red-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">Maximum number of simultaneous active sessions allowed.</p>
                </div>

                {settingsMsg && (
                  <p className={`text-sm ${settingsMsg.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>{settingsMsg}</p>
                )}

                <button
                  onClick={handleSaveSettings}
                  disabled={settingsSaving}
                  className="px-6 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {settingsSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>

            <div className="border-t border-gray-800 pt-6">
              <h3 className="font-semibold mb-2 text-gray-300">Security Note</h3>
              <p className="text-sm text-gray-500">
                User passwords are stored as bcrypt hashes and cannot be recovered. You can reset a user's password to a new value using the "Reset PW" button. All existing sessions for that user will be invalidated.
              </p>
            </div>
          </div>
        )}
      </div>

      {resetUser && (
        <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} />
      )}
    </div>
  );
}

export default function AdminPage() {
  const [phase, setPhase] = useState('loading');

  useEffect(() => {
    const init = async () => {
      try {
        const statusR = await fetch('/api/admin/status', { credentials: 'include' });
        const status = await statusR.json();
        if (!status.setup) { setPhase('setup'); return; }
        const checkR = await fetch('/api/admin/check', { credentials: 'include' });
        if (checkR.ok) setPhase('dashboard');
        else setPhase('login');
      } catch {
        setPhase('login');
      }
    };
    init();
  }, []);

  if (phase === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="animate-spin w-10 h-10 border-2 border-red-500 border-t-transparent rounded-full" />
      </div>
    );
  }
  if (phase === 'setup') return <SetupForm onSetup={() => setPhase('login')} />;
  if (phase === 'login') return <LoginForm onLogin={() => setPhase('dashboard')} />;
  return <Dashboard onLogout={() => setPhase('login')} />;
}
