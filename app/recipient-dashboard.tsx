import { router } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function RecipientDashboard() {
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.content}>
                <Text style={styles.heading}>Today's Reminders</Text>

                <View style={styles.reminderCard}>
                    <Text style={styles.time}>8:00 AM</Text>
                    <Text style={styles.title}>Take Blood Pressure Medication</Text>
                    <Text style={styles.subtitle}>1 pill after breakfast</Text>
                    <TouchableOpacity
                        style={styles.alertPreviewButton}
                        onPress={() => router.push('/reminder-alert')}
                    >
                        <Text style={styles.alertPreviewText}>Open Full-Screen Alert</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.takenButton}>
                        <Text style={styles.takenText}>Taken</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.laterButton}>
                        <Text style={styles.laterText}>Remind Me Later</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.skipButton}>
                        <Text style={styles.skipText}>Skip</Text>
                    </TouchableOpacity>
                </View>

                <View style={styles.reminderCard}>
                    <Text style={styles.time}>6:00 PM</Text>
                    <Text style={styles.title}>Take Vitamin D</Text>
                    <Text style={styles.subtitle}>Pending</Text>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F8F7F4' },
    content: { padding: 24 },
    heading: {
        fontSize: 32,
        fontWeight: '800',
        color: '#111827',
        marginBottom: 24,
    },
    reminderCard: {
        backgroundColor: '#FFFFFF',
        borderRadius: 22,
        padding: 22,
        marginBottom: 16,
    },
    time: {
        fontSize: 15,
        fontWeight: '700',
        color: '#2563EB',
        marginBottom: 8,
    },
    title: {
        fontSize: 24,
        fontWeight: '800',
        color: '#111827',
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 16,
        color: '#6B7280',
        marginBottom: 22,
    },
    takenButton: {
        backgroundColor: '#16A34A',
        paddingVertical: 18,
        borderRadius: 16,
        alignItems: 'center',
        marginBottom: 12,
    },
    takenText: { color: '#FFFFFF', fontSize: 17, fontWeight: '800' },
    laterButton: {
        backgroundColor: '#EFF6FF',
        paddingVertical: 18,
        borderRadius: 16,
        alignItems: 'center',
        marginBottom: 12,
    },
    laterText: { color: '#2563EB', fontSize: 17, fontWeight: '800' },
    skipButton: {
        backgroundColor: '#FEF2F2',
        paddingVertical: 18,
        borderRadius: 16,
        alignItems: 'center',
    },
    skipText: { color: '#DC2626', fontSize: 17, fontWeight: '800' },
    alertPreviewButton: {
        backgroundColor: '#111827',
        paddingVertical: 16,
        borderRadius: 16,
        alignItems: 'center',
        marginBottom: 14,
    },
    alertPreviewText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '900',
    },
});