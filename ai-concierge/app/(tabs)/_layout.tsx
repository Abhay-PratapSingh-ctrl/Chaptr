import React, { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, Tabs } from 'expo-router';

export default function TabLayout() {
  const [hasLocalTwin, setHasLocalTwin] = useState<boolean | null>(null);

  useEffect(() => {
    const checkLocalTwin = async () => {
      const [myOwner, myTwinId, myScoutRef] = await Promise.all([
        AsyncStorage.getItem('chaptr:my-owner'),
        AsyncStorage.getItem('chaptr:my-twin-id'),
        AsyncStorage.getItem('chaptr:my-scout-ref'),
      ]);

      console.log('TABS LOCAL TWIN CHECK:', { myOwner, myTwinId, myScoutRef });

      setHasLocalTwin(Boolean(myOwner && myTwinId && myScoutRef));
    };

    checkLocalTwin().catch(() => setHasLocalTwin(false));
  }, []);

  if (hasLocalTwin === null) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color="#D94A8C" />
          <Text style={styles.text}>Checking your Twin...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!hasLocalTwin) {
    return <Redirect href="/" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'AI Concierge' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  text: { color: '#A299A8', fontSize: 14 },
});