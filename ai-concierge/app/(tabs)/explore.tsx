import React from 'react';
import { StyleSheet, Text, View, SafeAreaView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export default function ExploreScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <LinearGradient
        colors={['rgba(217,74,140,0.1)', 'rgba(13,11,16,0.98)']}
        style={styles.gradient}
      >
        <View style={styles.content}>
          <Text style={styles.title}>Agent Settings</Text>
          <Text style={styles.subtitle}>
            Your Twin is currently managing your preferences autonomously on the blockchain.
          </Text>
          <View style={styles.card}>
            <Text style={styles.cardText}>Settings and manual overrides will be available in V2.</Text>
          </View>
        </View>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0D0B10',
  },
  gradient: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#D8D0DD',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
    maxWidth: '80%',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.2)',
  },
  cardText: {
    color: '#D94A8C',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
});

