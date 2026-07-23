import {
    createContext,
    ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Session } from '@supabase/supabase-js';

import { logout } from '@/lib/accountCleanup';
import { classifyAuthError } from '@/lib/authErrors';
import { supabase } from '@/lib/supabase';

// ─── Central auth/session controller ─────────────────────────────────────────
//
// The ONE place in the app that subscribes to Supabase auth-state changes
// and resolves the signed-in user's profile. Every screen that needs to
// know "am I signed in, and as whom" should read from useAuthSession()
// rather than independently calling supabase.auth.getUser()/getSession() —
// this is what prevents duplicate/competing listeners and inconsistent
// behavior across screens. Existing per-screen auth.getUser() calls before
// a data fetch are left in place as defense-in-depth (RLS is still the
// real authority), but route-level "am I even allowed to be on this
// screen" decisions should flow from this controller.
//
// Status meanings:
//  - initializing:    session restoration + first profile fetch in flight.
//                      Nothing should render a dashboard yet.
//  - authenticated:    valid session, active profile row loaded.
//  - unauthenticated:  no session (fresh install, explicit sign-out, or an
//                      auth error classified as non-recoverable).
//  - profile_missing:  valid session, but no profiles row exists yet (only
//                      expected transiently right after a signup that
//                      predates the handle_new_user trigger, or for the
//                      one-time backfilled legacy row — see the Week 1
//                      task #6 migration). Recoverable via choose-role.
//  - account_deleted:  valid session, but the profile is tombstoned
//                      (account_status = 'deleted'). The controller
//                      immediately starts a background logout() — this
//                      status is what lets the UI show one neutral message
//                      before that completes and status becomes
//                      unauthenticated.
//  - recoverable_error: the profile fetch failed for a reason classified
//                      as transient (network) rather than an invalid
//                      session — the existing session is NOT torn down,
//                      since erasing a valid session on a network blip
//                      would be worse than showing a retry state.
export type AuthStatus =
    | 'initializing'
    | 'authenticated'
    | 'unauthenticated'
    | 'profile_missing'
    | 'account_deleted'
    | 'recoverable_error';

export type AuthProfile = {
    role: 'caregiver' | 'recipient' | null;
    fullName: string | null;
};

/** Why the session most recently ended, for a one-time neutral message on the next signin screen. Consume via clearDeauthReason(). */
export type DeauthReason = 'account_deleted' | 'expired_session' | null;

type AuthSessionContextValue = {
    status: AuthStatus;
    session: Session | null;
    userId: string | null;
    profile: AuthProfile | null;
    /** True while the current session is a Supabase password-recovery session (user tapped a reset-password email link). Consumers must not auto-route this into a dashboard. */
    passwordRecovery: boolean;
    deauthReason: DeauthReason;
    clearDeauthReason: () => void;
    /** Re-runs the profile fetch for the current session — e.g. after choose-role sets a fresh role, or as a manual "Retry" action from a recoverable_error state. */
    refreshProfile: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSessionContextValue | null>(null);

export function AuthSessionProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<AuthStatus>('initializing');
    const [session, setSession] = useState<Session | null>(null);
    const [profile, setProfile] = useState<AuthProfile | null>(null);
    const [passwordRecovery, setPasswordRecovery] = useState(false);
    const [deauthReason, setDeauthReason] = useState<DeauthReason>(null);

    // Guards against a slow/stale profile fetch overwriting state from a
    // newer auth event that already resolved (e.g. INITIAL_SESSION's fetch
    // completing after a subsequent SIGNED_OUT already ran).
    const requestIdRef = useRef(0);

    const loadProfile = useCallback(async (userId: string, requestId: number) => {
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('role, full_name, account_status')
                .eq('id', userId)
                .maybeSingle();

            if (requestId !== requestIdRef.current) return; // superseded

            if (error) {
                const kind = classifyAuthError(error);
                if (kind === 'expired_session') {
                    // The session itself is no longer valid — this is the
                    // one profile-fetch failure mode that should actually
                    // sign the user out, since retrying won't help and an
                    // invalid session must not be left holding the app in
                    // an ambiguous state.
                    setProfile(null);
                    setStatus('unauthenticated');
                    setDeauthReason('expired_session');
                    logout().catch(() => {});
                    return;
                }
                // Network failure or an unclassified/unexpected error:
                // never tear down a session that might still be perfectly
                // valid — surface a retry state instead.
                setStatus('recoverable_error');
                return;
            }

            if (!data) {
                setProfile(null);
                setStatus('profile_missing');
                return;
            }

            if (data.account_status === 'deleted') {
                setProfile(null);
                setStatus('account_deleted');
                setDeauthReason('account_deleted');
                // Best-effort, non-blocking: end the local session for a
                // tombstoned account automatically. Never awaited here —
                // the UI reacts to `status` immediately; this just makes
                // sure a stray dangling session doesn't linger.
                logout().catch(() => {});
                return;
            }

            setProfile({ role: (data.role as AuthProfile['role']) ?? null, fullName: data.full_name ?? null });
            setStatus('authenticated');
        } catch {
            if (requestId !== requestIdRef.current) return;
            setStatus('recoverable_error');
        }
    }, []);

    const refreshProfile = useCallback(async () => {
        const currentUserId = session?.user?.id;
        if (!currentUserId) return;
        const requestId = ++requestIdRef.current;
        await loadProfile(currentUserId, requestId);
    }, [session, loadProfile]);

    const clearDeauthReason = useCallback(() => setDeauthReason(null), []);

    useEffect(() => {
        const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
            const requestId = ++requestIdRef.current;
            setSession(nextSession);

            if (event === 'PASSWORD_RECOVERY') {
                setPasswordRecovery(true);
            } else if (event === 'SIGNED_OUT') {
                setPasswordRecovery(false);
            }

            if (!nextSession?.user) {
                setProfile(null);
                setStatus('unauthenticated');
                return;
            }

            if (event === 'SIGNED_IN') {
                // A fresh, explicit sign-in (not the recovery flow) — any
                // stale deauth reason from a previous session no longer
                // applies.
                setDeauthReason(null);
            }

            setStatus('initializing');
            loadProfile(nextSession.user.id, requestId);
        });

        return () => subscription.unsubscribe();
    }, [loadProfile]);

    const value = useMemo<AuthSessionContextValue>(
        () => ({
            status,
            session,
            userId: session?.user?.id ?? null,
            profile,
            passwordRecovery,
            deauthReason,
            clearDeauthReason,
            refreshProfile,
        }),
        [status, session, profile, passwordRecovery, deauthReason, clearDeauthReason, refreshProfile]
    );

    return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionContextValue {
    const ctx = useContext(AuthSessionContext);
    if (!ctx) throw new Error('useAuthSession must be used within AuthSessionProvider');
    return ctx;
}
