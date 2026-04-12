import { useEffect, useRef, useState } from 'react';
import { getCsrfToken } from '../api';

export default function ChangePasswordModal({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const modalRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    previouslyFocusedRef.current = document.activeElement;
    const focusable = modal.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])');
    if (focusable.length) focusable[0].focus();

    function trapFocus(e) {
      if (e.key !== 'Tab' || !focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    modal.addEventListener('keydown', trapFocus);
    return () => {
      modal.removeEventListener('keydown', trapFocus);
      if (
        previouslyFocusedRef.current
        && document.contains(previouslyFocusedRef.current)
        && typeof previouslyFocusedRef.current.focus === 'function'
      ) {
        previouslyFocusedRef.current.focus();
      }
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (newPassword.length > 72) {
      setError('Password must be at most 72 characters');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCsrfToken(),
        },
        credentials: 'same-origin',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.ok) {
        setSuccess(true);
        setTimeout(onClose, 1500);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to change password');
      }
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
      onKeyDown={e => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        ref={modalRef}
        className="bg-slate-900 border border-slate-700 rounded-lg p-6 w-full max-w-sm shadow-xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-password-title"
      >
        <h2 id="change-password-title" className="text-lg font-semibold text-white mb-4">
          Change Password
        </h2>

        {success ? (
          <p className="text-green-400 text-sm">Password changed successfully.</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <label className="block text-sm font-medium text-slate-300 mb-1">Current Password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 mb-3"
              autoFocus
              autoComplete="current-password"
            />

            <label className="block text-sm font-medium text-slate-300 mb-1">New Password</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 mb-3"
              autoComplete="new-password"
            />

            <label className="block text-sm font-medium text-slate-300 mb-1">Confirm New Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              autoComplete="new-password"
            />

            {error && <p className="text-red-400 text-sm mt-2">{error}</p>}

            <div className="flex gap-3 mt-4">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !currentPassword || !newPassword || !confirmPassword}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white rounded-md text-sm font-medium transition-colors"
              >
                {loading ? 'Saving...' : 'Change Password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
