'use client';

import { useCallback, useEffect, useState } from 'react';
import { collection, doc, getDoc, getDocs, query, updateDoc, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAuth } from '@/hooks/useAuth';
import { getEditorialThemeColors } from '@/components/editorial/editorialTheme';

type UserRow = {
  uid: string;
  email?: string;
  displayName?: string;
  tier?: string;
};

interface AdminClientProps {
  initialTheme: 'light' | 'dark';
}

/**
 * Owner-only access management UI. Determines ownership by reading `config/owner` (uid) and
 * comparing it to the signed-in user. When the current user is NOT the owner, NO admin controls
 * are rendered — the Firestore rules are the real gate; this is UX only. The owner can list
 * trusted users and grant/revoke the `tier` field (trusted ⇄ standard) by searching a user's
 * exact email.
 */
export function AdminClient({ initialTheme }: AdminClientProps) {
  const tc = getEditorialThemeColors(initialTheme);
  const { user, loading: authLoading } = useAuth();

  const [ownerUid, setOwnerUid] = useState<string | null>(null);
  const [ownerLoading, setOwnerLoading] = useState(true);

  const [trusted, setTrusted] = useState<UserRow[]>([]);
  const [trustedLoading, setTrustedLoading] = useState(false);

  const [searchEmail, setSearchEmail] = useState('');
  const [searchResult, setSearchResult] = useState<
    { user?: UserRow; notFound?: boolean; error?: string } | null
  >(null);
  const [searching, setSearching] = useState(false);

  const [actingUid, setActingUid] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Read owner identity from config/owner (never hardcoded). Only read once authed.
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setOwnerLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'config', 'owner'));
        if (!cancelled) {
          const data = snap.data();
          setOwnerUid(snap.exists() && data && typeof data.uid === 'string' ? data.uid : null);
        }
      } catch (e) {
        console.error('admin: failed to read config/owner', e);
      } finally {
        if (!cancelled) setOwnerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, authLoading]);

  const isOwner = !!user && !!ownerUid && user.uid === ownerUid;

  const loadTrusted = useCallback(async () => {
    setTrustedLoading(true);
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('tier', '==', 'trusted')));
      const rows: UserRow[] = [];
      snap.forEach((d) => {
        const data = d.data();
        rows.push({ uid: d.id, email: data.email, displayName: data.displayName, tier: data.tier });
      });
      setTrusted(rows);
    } catch (e) {
      console.error('admin: failed to load trusted', e);
    } finally {
      setTrustedLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOwner) loadTrusted();
  }, [isOwner, loadTrusted]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const term = searchEmail.trim();
    if (!term) return;
    setSearching(true);
    setSearchResult(null);
    setActionError(null);
    try {
      const snap = await getDocs(query(collection(db, 'users'), where('email', '==', term)));
      if (snap.empty) {
        setSearchResult({ notFound: true });
      } else {
        const d = snap.docs[0];
        const data = d.data();
        setSearchResult({
          user: { uid: d.id, email: data.email ?? term, displayName: data.displayName, tier: data.tier },
        });
      }
    } catch (err) {
      console.error('admin: search failed', err);
      setSearchResult({ error: 'Search failed. Please try again.' });
    } finally {
      setSearching(false);
    }
  };

  const setTier = async (uid: string, tier: 'trusted' | 'standard') => {
    setActingUid(uid);
    setActionError(null);
    try {
      await updateDoc(doc(db, 'users', uid), { tier });
      await loadTrusted();
      setSearchResult((prev) =>
        prev && prev.user && prev.user.uid === uid ? { user: { ...prev.user, tier } } : prev
      );
    } catch (err) {
      console.error('admin: action failed', err);
      setActionError('Action failed — Firestore rules may have blocked it.');
    } finally {
      setActingUid(null);
    }
  };

  const resolving = authLoading || (!!user && ownerLoading);

  if (resolving) {
    return (
      <div className="flex items-center gap-3 py-8">
        <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
        <span className={`text-sm ${tc.fontClass} ${tc.muted}`}>Loading…</span>
      </div>
    );
  }

  if (!user || !isOwner) {
    return (
      <div className="py-8">
        <p className={`text-lg ${tc.text} ${tc.fontClass}`}>Not authorized</p>
        <p className={`mt-1 text-sm ${tc.muted} ${tc.fontClass}`}>
          Only the DropSync owner can access this page.
        </p>
      </div>
    );
  }

  const foundUser = searchResult?.user ?? null;

  return (
    <div className={`space-y-8 ${tc.fontClass}`}>
      {actionError && (
        <div className={`border ${tc.border} ${tc.roundedClass} px-4 py-3 text-sm ${tc.text}`}>
          {actionError}
        </div>
      )}

      {/* Currently trusted */}
      <section className={`border ${tc.border} ${tc.roundedClass} p-5`}>
        <h2 className={`text-base font-medium ${tc.text}`}>Currently trusted</h2>
        <p className={`mt-1 text-xs ${tc.muted}`}>Users who can create forever drops.</p>

        {trustedLoading ? (
          <div className="mt-4 flex items-center gap-2">
            <div className="w-4 h-4 border border-current/30 border-t-current animate-spin rounded-full" />
            <span className={`text-sm ${tc.muted}`}>Loading…</span>
          </div>
        ) : trusted.length === 0 ? (
          <p className={`mt-4 text-sm ${tc.muted}`}>No trusted users yet.</p>
        ) : (
          <div className="mt-4 space-y-2">
            {trusted.map((u) => {
              const self = u.uid === ownerUid;
              const acting = actingUid === u.uid;
              return (
                <div
                  key={u.uid}
                  className={`flex items-center justify-between gap-3 border ${tc.border} ${tc.roundedClass} px-4 py-3`}
                >
                  <div className="min-w-0">
                    <p className={`truncate text-sm ${tc.text}`}>
                      {u.email ?? '(no email)'} {self && <span className={tc.muted}>(you)</span>}
                    </p>
                    <p className={`truncate text-xs ${tc.muted}`}>{u.displayName ?? '—'}</p>
                  </div>
                  <button
                    type="button"
                    disabled={self || acting}
                    onClick={() => setTier(u.uid, 'standard')}
                    className={`shrink-0 border ${tc.border} ${tc.roundedClass} px-3 py-1.5 text-xs ${tc.text} ${tc.hoverBorder} disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {acting ? '…' : 'Revoke'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Grant access */}
      <section className={`border ${tc.border} ${tc.roundedClass} p-5`}>
        <h2 className={`text-base font-medium ${tc.text}`}>Grant access</h2>
        <p className={`mt-1 text-xs ${tc.muted}`}>
          Find a user by exact email to grant or revoke forever access.
        </p>

        <form onSubmit={handleSearch} className="mt-4 flex gap-2">
          <input
            type="email"
            value={searchEmail}
            onChange={(e) => setSearchEmail(e.target.value)}
            placeholder="user@example.com"
            className={`flex-1 border ${tc.border} ${tc.roundedClass} bg-transparent px-3 py-2 text-sm ${tc.text} ${tc.hoverBorder} focus:outline-none`}
          />
          <button
            type="submit"
            disabled={searching || !searchEmail.trim()}
            className={`${tc.activePillBg} ${tc.activePillText} ${tc.roundedClass} px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {searching ? '…' : 'Search'}
          </button>
        </form>

        {searchResult?.error && <p className={`mt-3 text-sm ${tc.text}`}>{searchResult.error}</p>}
        {searchResult?.notFound && (
          <p className={`mt-3 text-sm ${tc.muted}`}>No user found with that email.</p>
        )}
        {foundUser && (
          <div
            className={`mt-3 flex items-center justify-between gap-3 border ${tc.border} ${tc.roundedClass} px-4 py-3`}
          >
            <div className="min-w-0">
              <p className={`truncate text-sm ${tc.text}`}>
                {foundUser.email ?? '(no email)'}{' '}
                {foundUser.uid === ownerUid && <span className={tc.muted}>(you)</span>}
              </p>
              <p className={`text-xs ${tc.muted}`}>
                {foundUser.displayName ?? '—'} ·{' '}
                {foundUser.tier === 'trusted' ? 'Trusted' : 'Standard'}
              </p>
            </div>
            {foundUser.tier === 'trusted' ? (
              <button
                type="button"
                disabled={foundUser.uid === ownerUid || actingUid === foundUser.uid}
                onClick={() => setTier(foundUser.uid, 'standard')}
                className={`shrink-0 border ${tc.border} ${tc.roundedClass} px-3 py-1.5 text-xs ${tc.text} ${tc.hoverBorder} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {actingUid === foundUser.uid ? '…' : 'Revoke'}
              </button>
            ) : (
              <button
                type="button"
                disabled={actingUid === foundUser.uid}
                onClick={() => setTier(foundUser.uid, 'trusted')}
                className={`shrink-0 ${tc.activePillBg} ${tc.activePillText} ${tc.roundedClass} px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {actingUid === foundUser.uid ? '…' : 'Grant'}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
