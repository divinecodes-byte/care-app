import { router } from 'expo-router';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.content}>
                <Text style={styles.logo}>Care App</Text>

                <Text style={styles.title}>
                    Stay connected to the people who matter most.
                </Text>

                <Text style={styles.subtitle}>
                    Track medications, appointments, and daily care tasks from anywhere.
                </Text>

                <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => router.push('/signup')}
                >
                    <Text style={styles.primaryButtonText}>Get Started</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => router.push('/signin')}
                >
                    <Text style={styles.secondaryButtonText}>Sign In</Text>
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#F8F7F4',
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
    },
    logo: {
        fontSize: 22,
        fontWeight: '700',
        marginBottom: 30,
    },
    title: {
        fontSize: 36,
        fontWeight: '800',
        lineHeight: 44,
        marginBottom: 16,
        color: '#111827',
    },
    subtitle: {
        fontSize: 18,
        lineHeight: 28,
        color: '#6B7280',
        marginBottom: 40,
    },
    primaryButton: {
        backgroundColor: '#2563EB',
        paddingVertical: 18,
        borderRadius: 16,
        alignItems: 'center',
        marginBottom: 12,
    },
    primaryButtonText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '700',
    },
    secondaryButton: {
        borderWidth: 1,
        borderColor: '#D1D5DB',
        paddingVertical: 18,
        borderRadius: 16,
        alignItems: 'center',
    },
    secondaryButtonText: {
        fontSize: 16,
        fontWeight: '700',
        color: '#111827',
    },
});