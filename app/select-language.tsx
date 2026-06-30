import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Image, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useLanguage } from '@/lib/i18n/context';
import { LanguageMode } from '@/lib/i18n/storage';
import { useThemeColors } from '@/lib/theme';

// Shown once, before the user has picked a language, so the copy can't yet
// rely on the translation system — it's deliberately bilingual.
const OPTIONS: { mode: LanguageMode; icon: string; en: string; es: string }[] = [
    { mode: 'en',     icon: 'language',         en: 'English', es: 'English' },
    { mode: 'es',     icon: 'language',         en: 'Español', es: 'Español' },
    { mode: 'system', icon: 'phone-portrait-outline', en: 'Use System Language', es: 'Usar idioma del sistema' },
];

export default function SelectLanguageScreen() {
    const C = useThemeColors();
    const styles = useMemo(() => createStyles(C), [C]);
    const { setLanguageMode } = useLanguage();
    const [choosing, setChoosing] = useState<LanguageMode | null>(null);

    async function choose(mode: LanguageMode) {
        if (choosing) return;
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        setChoosing(mode);
        await setLanguageMode(mode);
        router.replace('/');
    }

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.content}>
                <View style={styles.logoRow}>
                    <Image
                        source={require('@/assets/brand/tavora-mark.png')}
                        style={styles.logoMark}
                        resizeMode="contain"
                    />
                    <Text style={styles.logoText}>Tavora</Text>
                </View>

                <Text style={styles.title}>Choose your language</Text>
                <Text style={styles.titleEs}>Elige tu idioma</Text>

                <Text style={styles.subtitle}>
                    You can change this later in Settings.{'\n'}
                    Puedes cambiarlo después en Configuración.
                </Text>

                <View style={styles.cards}>
                    {OPTIONS.map((option) => {
                        const isChoosing = choosing === option.mode;
                        return (
                            <TouchableOpacity
                                key={option.mode}
                                style={[
                                    styles.card,
                                    SHADOW.sm,
                                    choosing !== null && !isChoosing && styles.cardDimmed,
                                ]}
                                onPress={() => choose(option.mode)}
                                disabled={choosing !== null}
                                activeOpacity={0.82}
                            >
                                <View style={styles.cardIconWrap}>
                                    <Ionicons name={option.icon as any} size={22} color={C.primary} />
                                </View>
                                <View style={styles.cardBody}>
                                    <Text style={styles.cardTitle}>{option.en}</Text>
                                    {option.es !== option.en ? (
                                        <Text style={styles.cardSubtitle}>{option.es}</Text>
                                    ) : null}
                                </View>
                                <Ionicons name="chevron-forward" size={20} color={C.textMuted} />
                            </TouchableOpacity>
                        );
                    })}
                </View>
            </View>
        </SafeAreaView>
    );
}

const createStyles = (C: ThemeColors) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: C.bgPage,
    },
    content: {
        flex: 1,
        paddingHorizontal: 28,
        justifyContent: 'center',
    },

    logoRow: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'center',
        marginBottom: 40,
    },
    logoMark: {
        width: 32,
        height: 32,
        marginRight: 8,
    },
    logoText: {
        fontSize: 18,
        fontWeight: '800',
        color: C.textPrimary,
        letterSpacing: -0.4,
    },

    title: {
        fontSize: 28,
        fontWeight: '800',
        color: C.textPrimary,
        textAlign: 'center',
        letterSpacing: -0.6,
    },
    titleEs: {
        fontSize: 17,
        fontWeight: '600',
        color: C.textSecondary,
        textAlign: 'center',
        marginTop: 4,
        marginBottom: 16,
    },
    subtitle: {
        fontSize: 14,
        color: C.textMuted,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: 36,
    },

    cards: {
        gap: 12,
    },
    card: {
        backgroundColor: C.bgSurface,
        borderRadius: RADIUS.xl,
        padding: 18,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1.5,
        borderColor: C.border,
    },
    cardDimmed: {
        opacity: 0.45,
    },
    cardIconWrap: {
        width: 44,
        height: 44,
        borderRadius: RADIUS.lg,
        backgroundColor: C.primaryLight,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 14,
        flexShrink: 0,
    },
    cardBody: {
        flex: 1,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: C.textPrimary,
        letterSpacing: -0.2,
    },
    cardSubtitle: {
        fontSize: 13,
        color: C.textMuted,
        marginTop: 2,
    },
});
