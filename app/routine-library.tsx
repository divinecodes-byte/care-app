import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AccessibleSectionHeader } from '@/components/AccessiblePrimitives';
import { EmptyState, OfflineBanner, SectionErrorState } from '@/components/StateViews';
import { RADIUS, SHADOW, ThemeColors } from '@/constants/theme';
import { useTranslation } from '@/lib/i18n/context';
import { UseCase } from '@/lib/onboardingCore';
import { BUILT_IN_ROUTINE_PACKS, BuiltInPack } from '@/lib/routineCatalog';
import { summarizeItemCounts } from '@/lib/routineCore';
import { supabase } from '@/lib/supabase';
import { useThemeColors } from '@/lib/theme';

type PersonalTemplateRow = {
    id: string;
    title: string;
    description: string | null;
    status: 'active' | 'archived';
    reminderCount: number;
    taskCount: number;
};

export default function RoutineLibraryScreen() {
    const C = useThemeColors();
    const t = useTranslation();
    const styles = useMemo(() => createStyles(C), [C]);
    const { connectionId: preselectConnectionId } = useLocalSearchParams<{ connectionId?: string }>();

    const [useCase, setUseCase] = useState<UseCase | null>(null);
    const [templates, setTemplates] = useState<PersonalTemplateRow[]>([]);
    const [archivedTemplates, setArchivedTemplates] = useState<PersonalTemplateRow[]>([]);
    const [templatesStatus, setTemplatesStatus] = useState<'loading' | 'ready' | 'error' | 'offline'>('loading');
    const [showArchived, setShowArchived] = useState(false);

    const load = useCallback(async () => {
        setTemplatesStatus('loading');
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setTemplatesStatus('error'); return; }

        const { data: profile } = await supabase.from('profiles').select('use_case').eq('id', user.id).maybeSingle();
        if (profile?.use_case) setUseCase(profile.use_case as UseCase);

        const { data, error } = await supabase
            .from('routine_templates')
            .select('id, title, description, status, routine_template_items(item_kind)')
            .eq('owner_id', user.id)
            .order('updated_at', { ascending: false });

        if (error) {
            setTemplatesStatus(/network|fetch/i.test(error.message) ? 'offline' : 'error');
            return;
        }

        const rows: PersonalTemplateRow[] = (data ?? []).map((row: any) => {
            const { reminderCount, taskCount } = summarizeItemCounts((row.routine_template_items ?? []) as { itemKind: 'reminder' | 'task' }[]);
            return { id: row.id, title: row.title, description: row.description, status: row.status, reminderCount, taskCount };
        });

        setTemplates(rows.filter((r) => r.status === 'active'));
        setArchivedTemplates(rows.filter((r) => r.status === 'archived'));
        setTemplatesStatus('ready');
    }, []);

    useEffect(() => { load(); }, [load]);

    const recommendedPacks = useMemo(
        () => (useCase ? BUILT_IN_ROUTINE_PACKS.filter((p) => p.recommendedUseCases.includes(useCase)) : []),
        [useCase]
    );

    function openPackPreview(pack: BuiltInPack) {
        router.push({
            pathname: '/routine-preview',
            params: { builtInPackId: pack.packId, connectionId: preselectConnectionId ?? '' },
        });
    }

    function openTemplatePreview(templateId: string) {
        router.push({
            pathname: '/routine-preview',
            params: { templateId, connectionId: preselectConnectionId ?? '' },
        });
    }

    function PackCard({ pack }: { pack: BuiltInPack }) {
        const itemCounts = summarizeItemCounts(pack.items);
        return (
            <TouchableOpacity
                style={[styles.card, SHADOW.xs]}
                onPress={() => openPackPreview(pack)}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel={`${t(pack.titleKey)}. ${t('routineLibrary.reminderCount', { n: itemCounts.reminderCount, plural: itemCounts.reminderCount === 1 ? '' : 's' })}, ${t('routineLibrary.taskCount', { n: itemCounts.taskCount, plural: itemCounts.taskCount === 1 ? '' : 's' })}`}
            >
                <View style={styles.cardHeaderRow}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{t(pack.titleKey)}</Text>
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{t('routineLibrary.builtInBadge')}</Text>
                    </View>
                </View>
                <Text style={styles.cardDescription} numberOfLines={2}>{t(pack.descriptionKey)}</Text>
                <View style={styles.cardCountsRow}>
                    <Text style={styles.cardCountsText}>
                        {t('routineLibrary.reminderCount', { n: itemCounts.reminderCount, plural: itemCounts.reminderCount === 1 ? '' : 's' })}
                        {'  ·  '}
                        {t('routineLibrary.taskCount', { n: itemCounts.taskCount, plural: itemCounts.taskCount === 1 ? '' : 's' })}
                    </Text>
                </View>
                <Text style={styles.useTemplateLink}>{t('routineLibrary.useTemplate')}</Text>
            </TouchableOpacity>
        );
    }

    function TemplateCard({ template, archived = false }: { template: PersonalTemplateRow; archived?: boolean }) {
        return (
            <TouchableOpacity
                style={[styles.card, SHADOW.xs]}
                onPress={() => !archived && openTemplatePreview(template.id)}
                activeOpacity={archived ? 1 : 0.85}
                accessibilityRole="button"
                accessibilityLabel={`${template.title}. ${t('routineLibrary.reminderCount', { n: template.reminderCount, plural: template.reminderCount === 1 ? '' : 's' })}, ${t('routineLibrary.taskCount', { n: template.taskCount, plural: template.taskCount === 1 ? '' : 's' })}`}
            >
                <View style={styles.cardHeaderRow}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{template.title}</Text>
                    <View style={[styles.badge, styles.personalBadge]}>
                        <Text style={styles.badgeText}>{t('routineLibrary.personalBadge')}</Text>
                    </View>
                </View>
                {!!template.description && <Text style={styles.cardDescription} numberOfLines={2}>{template.description}</Text>}
                <View style={styles.cardCountsRow}>
                    <Text style={styles.cardCountsText}>
                        {t('routineLibrary.reminderCount', { n: template.reminderCount, plural: template.reminderCount === 1 ? '' : 's' })}
                        {'  ·  '}
                        {t('routineLibrary.taskCount', { n: template.taskCount, plural: template.taskCount === 1 ? '' : 's' })}
                    </Text>
                </View>
                {!archived && <Text style={styles.useTemplateLink}>{t('routineLibrary.useTemplate')}</Text>}
            </TouchableOpacity>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                        <Ionicons name="chevron-back" size={24} color={C.primary} />
                    </TouchableOpacity>
                    <Text style={styles.heading} accessibilityRole="header">{t('routineLibrary.heading')}</Text>
                    <View style={{ width: 24 }} />
                </View>

                {templatesStatus === 'offline' && (
                    <OfflineBanner />
                )}
                {templatesStatus === 'error' && (
                    <SectionErrorState text={t('routineLibrary.loadFailedText')} onRetry={load} retrying={false} />
                )}

                {recommendedPacks.length > 0 && (
                    <View style={styles.section}>
                        <AccessibleSectionHeader title={t('routineLibrary.recommendedSection')} />
                        {recommendedPacks.map((pack) => <PackCard key={pack.packId} pack={pack} />)}
                    </View>
                )}

                <View style={styles.section}>
                    <AccessibleSectionHeader title={t('routineLibrary.tavoraPacksSection')} />
                    {BUILT_IN_ROUTINE_PACKS.map((pack) => <PackCard key={pack.packId} pack={pack} />)}
                </View>

                <View style={styles.section}>
                    <AccessibleSectionHeader title={t('routineLibrary.myTemplatesSection')} />
                    {templatesStatus === 'loading' && (
                        <View style={styles.loadingRow}>
                            <ActivityIndicator color={C.primary} />
                        </View>
                    )}
                    {templatesStatus !== 'loading' && templates.length === 0 && (
                        <EmptyState
                            icon="albums-outline"
                            title={t('routineLibrary.noPersonalTemplatesTitle')}
                            text={t('routineLibrary.noPersonalTemplatesText')}
                        />
                    )}
                    {templates.map((template) => <TemplateCard key={template.id} template={template} />)}
                </View>

                {archivedTemplates.length > 0 && (
                    <View style={styles.section}>
                        <TouchableOpacity
                            onPress={() => setShowArchived((v) => !v)}
                            accessibilityRole="button"
                            accessibilityState={{ expanded: showArchived }}
                            accessibilityLabel={t('routineLibrary.viewArchived')}
                            style={styles.archivedToggle}
                        >
                            <Text style={styles.archivedToggleText}>{t('routineLibrary.viewArchived')}</Text>
                            <Ionicons name={showArchived ? 'chevron-up' : 'chevron-down'} size={18} color={C.textSecondary} />
                        </TouchableOpacity>
                        {showArchived && archivedTemplates.map((template) => <TemplateCard key={template.id} template={template} archived />)}
                    </View>
                )}
            </ScrollView>
        </SafeAreaView>
    );
}

function createStyles(C: ThemeColors) {
    return StyleSheet.create({
        container: { flex: 1, backgroundColor: C.bgPage },
        content: { padding: 20, paddingBottom: 48 },
        header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
        heading: { fontSize: 20, fontWeight: '700', color: C.textPrimary },
        section: { marginBottom: 24 },
        loadingRow: { paddingVertical: 20, alignItems: 'center' },
        card: { backgroundColor: C.bgSurface, borderRadius: RADIUS.md, padding: 16, marginTop: 12, minHeight: 44 },
        cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        cardTitle: { fontSize: 16, fontWeight: '700', color: C.textPrimary, flexShrink: 1 },
        cardDescription: { fontSize: 13, color: C.textSecondary, marginTop: 4 },
        cardCountsRow: { marginTop: 8 },
        cardCountsText: { fontSize: 12, color: C.textMuted },
        useTemplateLink: { fontSize: 14, fontWeight: '600', color: C.primary, marginTop: 10 },
        badge: { backgroundColor: C.primaryLight, borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 },
        personalBadge: { backgroundColor: C.bgAlt },
        badgeText: { fontSize: 11, fontWeight: '600', color: C.primary },
        archivedToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, minHeight: 44 },
        archivedToggleText: { fontSize: 14, fontWeight: '600', color: C.textSecondary },
    });
}
