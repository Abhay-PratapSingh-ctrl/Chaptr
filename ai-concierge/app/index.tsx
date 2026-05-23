import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { setupZkLoginParams } from '@/utils/zkLoginService';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

const hasLocalTwin = async () => {
  const [myOwner, myTwinId, myScoutRef] = await Promise.all([
    AsyncStorage.getItem('chaptr:my-owner'),
    AsyncStorage.getItem('chaptr:my-twin-id'),
    AsyncStorage.getItem('chaptr:my-scout-ref'),
  ]);

  return Boolean(myOwner && myTwinId && myScoutRef);
};

export default function ConnectScreen() {
  const [isChecking, setIsChecking] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    hasLocalTwin()
      .then((hasTwin) => {
        if (!mounted) return;

        if (hasTwin) {
          router.replace('/(tabs)' as Href);
          return;
        }

        setIsChecking(false);
      })
      .catch(() => {
        if (!mounted) return;
        setIsChecking(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleConnect = async () => {
    try {
      setError(null);
      setIsConnecting(true);

      if (!GOOGLE_CLIENT_ID) {
        throw new Error('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');
      }

      const { nonce } = await setupZkLoginParams();
      const redirectUri = AuthSession.makeRedirectUri();

      const request = new AuthSession.AuthRequest({
        clientId: GOOGLE_CLIENT_ID,
        responseType: AuthSession.ResponseType.IdToken,
        scopes: ['openid', 'email', 'profile'],
        redirectUri,
        extraParams: {
          nonce,
          prompt: 'select_account',
        },
        usePKCE: false,
      });

      const result = await request.promptAsync(discovery);

      if (result.type !== 'success') {
        throw new Error('Google sign-in was cancelled');
      }

      const jwt = result.params.id_token;

      if (!jwt) {
        throw new Error('Google did not return an id_token');
      }

      router.push({
        pathname: '/onboarding',
        params: { jwt },
      } as Href);
    } catch (e: any) {
      setError(e?.message ?? 'Could not connect Google account.');
    } finally {
      setIsConnecting(false);
    }
  };

  if (isChecking) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color="#D94A8C" />
          <Text style={styles.muted}>Checking your Chaptr identity...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.container}>
        <Text style={styles.logo}>Chaptr.</Text>
        <Text style={styles.title}>Let your Twin scout first.</Text>
        <Text style={styles.subtitle}>
          Connect with Google to create your private Chaptr identity, then build your Digital Twin.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={styles.button}
          onPress={handleConnect}
          disabled={isConnecting}
          activeOpacity={0.9}
        >
          <LinearGradient colors={['#D94A8C', '#7A3EB8']} style={styles.buttonGradient}>
            {isConnecting ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.buttonText}>Connect with Google</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        <Text style={styles.note}>
          Your browser needs a local Twin before the scout feed opens.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: '#A299A8', fontSize: 14 },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  logo: {
    color: '#FDFBF7',
    fontSize: 28,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 28,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  title: {
    color: '#FDFBF7',
    fontSize: 38,
    lineHeight: 44,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 14,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  subtitle: {
    color: '#A299A8',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
    marginBottom: 28,
  },
  error: {
    color: '#f87171',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 14,
  },
  button: {
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
  },
  buttonGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '800',
  },
  note: {
    color: '#6D6175',
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 18,
  },
});
