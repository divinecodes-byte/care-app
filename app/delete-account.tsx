import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { performLocalAccountCleanup } from '@/lib/accountCleanup';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';
import { useFocusOnChange } from '@/lib/useAccessibilityFocus';

const CONFIRM_WORD = 'DELETE';

type Stage = 'form' | 'submitting' | 'success';

export default function DeleteAccountScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = createStyles(C);

    const [confirmText, setConfirmText] = useState('');
    const [password, setPassword]       = useState('');
    const [stage, setStage]             = useState<Stage>('form');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const errorRef = useFocusOnChange<Text>(errorMessage);

    const confirmMatches = confirmText.trim() === CONFIRM_WORD;
    const canSubmit = confirmMatches && password.length > 0 && stage !== 'submitting';

    async function handleDelete() {
        if (!canSubmit) return;

        if (Platform.OS === 'ios') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setErrorMessage(null);
        setStage('submitting');

        const { data: { user } } = await supabase.auth.getUser();
        const email = user?.email;

        if (!email) {
            setStage('form');
            setPassword('');
            setErrorMessage(t('deleteAccount.sessionExpired'));
            return;
        }

        // Reauthenticate with the current password before anything else —
        // this both confirms the password and mints a fresh session token,
        // which the delete-account function separately requires to be
        // recently issued. Never stored or logged beyond this call.
        const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password });

        if (reauthError) {
            setStage('form');
            setPassword('');
            setErrorMessage(t('deleteAccount.wrongPassword'));
            return;
        }

        const { data, error: invokeError } = await supabase.functions.invoke('delete-account');

        if (invokeError || (data && data.error)) {
            setStage('form');
            setPassword('');
            setErrorMessage(t('deleteAccount.deletionFailed'));
            return;
        }

        // Server deletion succeeded. Cancel local notifications, clear
        // account-scoped device state, and clear the session — then reset
        // navigation to the unauthenticated welcome route so there is no
        // back-stack entry that could return into an authenticated screen.
        await performLocalAccountCleanup();
        setStage('success');
        router.replace('/');
    }

    if (stage === 'success') {
        return (
            <SafeAreaView style={styles.container}>
                <View
                    style={styles.centered}
                    accessible
                    accessibilityRole="progressbar"
                    accessibilityLabel={t('deleteAccount.deletingInProgress')}
                    accessibilityLiveRegion="polite"
                >
                    <ActivityIndicator color={C.primary} size="large" />
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView style={styles.kav} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                <ScrollView
                    contentContainerStyle={styles.content}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    <TouchableOpacity
                        style={styles.backButton}
                        onPress={() => router.back()}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        disabled={stage === 'submitting'}
                        accessibilityRole="button"
                        accessibilityLabel={t('reminderForm.back')}
                        accessibilityState={{ disabled: stage === 'submitting' }}
                    >
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>{t('reminderForm.back')}</Text>
                    </TouchableOpacity>

                    <View style={styles.warningIconWrap} importantForAccessibility="no-hide-descendants">
                        <Ionicons name="warning" size={28} color={C.error} />
                    </View>

                    <Text style={styles.heading} accessibilityRole="header">{t('deleteAccount.title')}</Text>

                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        {[
                            t('deleteAccount.pointPermanent'),
                            t('deleteAccount.pointConnectionsEnd'),
                            t('deleteAccount.pointRemindersStop'),
                            t('deleteAccount.pointHistoryLost'),
                        ].map((line, i) => (
                            <View key={i} style={styles.bulletRow} accessible accessibilityLabel={line}>
                                <Text style={styles.bulletDot}>•</Text>
                                <Text style={styles.bulletText}>{line}</Text>
                            </View>
                        ))}
                        <Text style={styles.cannotUndoText}>{t('deleteAccount.cannotUndo')}</Text>
                    </View>

                    <View style={[styles.sectionCard, SHADOW.xs]}>
                        <Text style={styles.label}>{t('deleteAccount.confirmLabel', { word: CONFIRM_WORD })}</Text>
                        <TextInput
                            style={styles.input}
                            value={confirmText}
                            onChangeText={setConfirmText}
                            autoCapitalize="characters"
                            autoCorrect={false}
                            placeholder={CONFIRM_WORD}
                            placeholderTextColor={C.textMuted}
                            editable={stage !== 'submitting'}
                            accessibilityLabel={t('deleteAccount.confirmLabel', { word: CONFIRM_WORD })}
                            accessibilityHint={t('deleteAccount.confirmHint')}
                        />

                        <Text style={[styles.label, { marginTop: 18 }]}>{t('deleteAccount.passwordLabel')}</Text>
                        <TextInput
                            style={styles.input}
                            value={password}
                            onChangeText={setPassword}
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            textContentType="password"
                            autoComplete="current-password"
                            placeholder={t('deleteAccount.passwordPlaceholder')}
                            placeholderTextColor={C.textMuted}
                            editable={stage !== 'submitting'}
                            accessibilityLabel={t('deleteAccount.passwordLabel')}
                        />

                        {errorMessage ? (
                            <Text
                                ref={errorRef}
                                style={styles.errorText}
                                accessibilityRole="alert"
                                accessibilityLiveRegion="assertive"
                            >
                                {errorMessage}
                            </Text>
                        ) : null}
                    </View>

                    <TouchableOpacity
                        style={[styles.deleteButton, SHADOW.md, (!canSubmit) && styles.deleteButtonDisabled]}
                        onPress={handleDelete}
                        disabled={!canSubmit}
                        activeOpacity={0.88}
                        accessibilityRole="button"
                        accessibilityLabel={t('deleteAccount.finalButton')}
                        accessibilityHint={t('deleteAccount.finalButtonHint')}
                        accessibilityState={{ disabled: !canSubmit, busy: stage === 'submitting' }}
                    >
                        {stage === 'submitting' ? (
                            <ActivityIndicator color={C.textInverse} />
                        ) : (
                            <Text style={styles.deleteButtonText}>{t('deleteAccount.finalButton')}</Text>
                        )}
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    kav:       { flex: 1 },
    content: {
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: 48,
    },
    centered: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },

    backButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 20,
        alignSelf: 'flex-start',
    },
    backText: {
        fontSize: 16,
        fontWeight: '600',
        color: C.primary,
        marginLeft: 2,
    },

    warningIconWrap: {
        width: 56,
        height: 56,
        borderRadius: RADIUS.lg,
        backgroundColor: '#FEF2F2',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    heading: {
        fontSize: 26,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.5,
        marginBottom: 20,
    },

    sectionCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: C.border,
    },
    bulletRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 10,
    },
    bulletDot: {
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
    },
    bulletText: {
        flex: 1,
        fontSize: 15,
        color: C.textSecondary,
        lineHeight: 22,
    },
    cannotUndoText: {
        fontSize: 14,
        fontWeight: '700',
        color: C.error,
        marginTop: 4,
        lineHeight: 20,
    },

    label: {
        fontSize: 13,
        fontWeight: '700',
        color: C.textPrimary,
        marginBottom: 8,
        letterSpacing: 0.1,
    },
    input: {
        backgroundColor: C.bgAlt,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 14,
        paddingVertical: Platform.OS === 'ios' ? 14 : 12,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: 'transparent',
        color: C.textPrimary,
        fontWeight: '500',
    },
    errorText: {
        fontSize: 13,
        color: C.error,
        fontWeight: '600',
        marginTop: 12,
    },

    deleteButton: {
        backgroundColor: C.error,
        paddingVertical: 18,
        borderRadius: RADIUS.xl,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 6,
    },
    deleteButtonDisabled: { opacity: 0.4 },
    deleteButtonText: {
        color: C.textInverse,
        fontSize: 17,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
});
