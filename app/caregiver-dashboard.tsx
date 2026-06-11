import { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CaregiverDashboard() {
  const [selectedTab, setSelectedTab] = useState('Month');

  const data = {
    Today: {
      adherence: '100%',
      streak: '1 Day',
      missed: '0',
    },
    Week: {
      adherence: '86%',
      streak: '6 Days',
      missed: '1',
    },
    Month: {
      adherence: '92%',
      streak: '12 Days',
      missed: '3',
    },
  };

  const current =
    data[selectedTab as keyof typeof data];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.heading}>Care Overview</Text>

        <View style={styles.tabContainer}>
          {['Today', 'Week', 'Month'].map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[
                styles.tab,
                selectedTab === tab && styles.activeTab,
              ]}
              onPress={() => setSelectedTab(tab)}
            >
              <Text
                style={[
                  styles.tabText,
                  selectedTab === tab && styles.activeTabText,
                ]}
              >
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Adherence Rate</Text>
          <Text style={styles.bigMetric}>
            {current.adherence}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Current Streak
          </Text>
          <Text style={styles.metric}>
            {current.streak}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Missed Reminders
          </Text>
          <Text style={styles.metric}>
            {current.missed}
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Recent Activity
          </Text>

          <Text style={styles.activity}>
            ✓ Blood Pressure Medication
          </Text>

          <Text style={styles.activity}>
            ✓ Morning Walk
          </Text>

          <Text style={styles.activity}>
            ⚠ Vitamin D Missed
          </Text>
        </View>
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
    padding: 24,
  },
  heading: {
    fontSize: 32,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 24,
  },
  tabContainer: {
    flexDirection: 'row',
    marginBottom: 24,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  activeTab: {
    backgroundColor: '#2563EB',
  },
  tabText: {
    fontWeight: '700',
    color: '#6B7280',
  },
  activeTabText: {
    color: '#FFFFFF',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
    color: '#374151',
  },
  bigMetric: {
    fontSize: 48,
    fontWeight: '900',
    color: '#2563EB',
  },
  metric: {
    fontSize: 34,
    fontWeight: '800',
    color: '#111827',
  },
  activity: {
    fontSize: 15,
    color: '#4B5563',
    marginBottom: 8,
  },
});