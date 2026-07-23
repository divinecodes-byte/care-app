import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
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

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { useThemeColors } from '@/lib/theme';
import { supabase } from '@/lib/supabase';

// The app's own deep-link scheme (see app.json's "scheme": "tavora"),
// caught by app/reset-password.tsx, which exchanges the recovery tokens/
// code in the incoming URL for a session before showing the new-password
// form. detectSessionInUrl is false on the Supabase client (this is a
// native app, not a browser), so that screen parses the URL manually
// rather than relying on any automatic handling.
const RESET_REDIRECT_URL = 'tavora://reset-password';

export default function ForgotPasswordScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [sent, setSent] = useState(false);

    async function handleSubmit() {
        if (!email.trim()) return;

        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setLoading(true);

        // Always show the same neutral confirmation regardless of the
        // actual result — whether or not an account exists for this email
        // is not information this screen should ever reveal.
        await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: RESET_REDIRECT_URL }).catch(() => {});

        setLoading(false);
        setSent(true);
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
            <KeyboardAvoidingView style={styles.kav} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
                <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                    <TouchableOpacity style={styles.backButton} onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="chevron-back" size={22} color={C.primary} />
                        <Text style={styles.backText}>{t('common.back')}</Text>
                    </TouchableOpacity>

                    <Text style={styles.heading}>{t('forgotPassword.heading')}</Text>

                    {sent ? (
                        <View style={styles.confirmCard}>
                            <Ionicons name="mail-outline" size={28} color={C.primary} style={{ marginBottom: 10 }} />
                            <Text style={styles.confirmText}>{t('forgotPassword.sentMessage')}</Text>
                            <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/signin')}>
                                <Text style={styles.secondaryButtonText}>{t('forgotPassword.backToSignin')}</Text>
                            </TouchableOpacity>
                        </View>
                    ) : (
                        <>
                            <Text style={styles.subheading}>{t('forgotPassword.subheading')}</Text>

                            <View style={styles.formGroup}>
                                <Text style={styles.label}>{t('signin.emailLabel')}</Text>
                                <TextInput
                                    style={styles.input}
                                    placeholder={t('signin.emailPlaceholder')}
                                    placeholderTextColor={C.textMuted}
                                    keyboardType="email-address"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    value={email}
                                    onChangeText={setEmail}
                                    returnKeyType="done"
                                    onSubmitEditing={handleSubmit}
                                />
                            </View>

                            <TouchableOpacity
                                style={[styles.button, SHADOW.primary, (loading || !email.trim()) && styles.buttonDisabled]}
                                onPress={handleSubmit}
                                disabled={loading || !email.trim()}
                                activeOpacity={0.88}
                            >
                                {loading ? <ActivityIndicator color={C.textInverse} /> : <Text style={styles.buttonText}>{t('forgotPassword.submit')}</Text>}
                            </TouchableOpacity>
                        </>
                    )}
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: { flex: 1, backgroundColor: C.bgPage },
    kav: { flex: 1 },
    scroll: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 12, paddingBottom: 32 },
    backButton: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, alignSelf: 'flex-start' },
    backText: { fontSize: 16, fontWeight: '600', color: C.primary, marginLeft: 2 },
    heading: { fontSize: 30, fontWeight: '800', color: C.textPrimary, letterSpacing: -0.6, marginBottom: 10 },
    subheading: { fontSize: 16, color: C.textSecondary, lineHeight: 24, marginBottom: 28 },
    formGroup: { marginBottom: 18 },
    label: { fontSize: 14, fontWeight: '700', color: C.textPrimary, marginBottom: 8 },
    input: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.lg,
        paddingHorizontal: 16,
        paddingVertical: Platform.OS === 'ios' ? 16 : 14,
        fontSize: 16,
        borderWidth: 1.5,
        borderColor: C.border,
        color: C.textPrimary,
        ...SHADOW.xs,
    },
    button: { backgroundColor: C.primary, paddingVertical: 18, borderRadius: RADIUS.xl, alignItems: 'center', marginTop: 8 },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: C.textInverse, fontSize: 17, fontWeight: '700' },
    confirmCard: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 24,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: C.border,
    },
    confirmText: { fontSize: 15, color: C.textSecondary, textAlign: 'center', lineHeight: 22, marginBottom: 20 },
    secondaryButton: { paddingVertical: 12, paddingHorizontal: 20 },
    secondaryButtonText: { fontSize: 15, fontWeight: '700', color: C.primary },
});
