import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { setupZkLoginParams } from '@/utils/zkLoginService'; // Adjust path if your utils folder is elsewhere

// Required by Expo to close the web browser after Google login
WebBrowser.maybeCompleteAuthSession();

// 🔴 PASTE YOUR GOOGLE CLIENT ID HERE
const GOOGLE_CLIENT_ID = "393632906983-5tdf61s5s8euuqq6vn6i40lf8usgi0ja.apps.googleusercontent.com";

export default function IndexScreen() {
  const [nonce, setNonce] = useState('');
  const [ephemeralKey, setEphemeralKey] = useState<any>(null);
  const [maxEpochState, setMaxEpochState] = useState<number>(0);
  const [randomnessState, setRandomnessState] = useState<string>('');

  // 1. Prepare the ZK Login params in the background when the app opens
  useEffect(() => {
    const initZk = async () => {
      try {
        const params = await setupZkLoginParams();
        setNonce(params.nonce);
        setEphemeralKey(params.ephemeralKeyPair);
        setMaxEpochState(params.maxEpoch);
        setRandomnessState(params.randomness.toString());
      } catch (error) {
        console.error("Failed to generate zkLogin params:", error);
      }
    };
    initZk();
  }, []);

  // 2. Configure the Google Auth Request
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      responseType: 'id_token',
      scopes: ['openid', 'email', 'profile'],
      redirectUri: AuthSession.makeRedirectUri(),
      // The magic key: Google signs this nonce, proving the user owns the ephemeral key
      extraParams: nonce ? { nonce: nonce } : {}, 
    },
    { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth' }
  );

  // 3. Listen for the Google response
  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params;
      console.log("✅ GOOGLE JWT SECURED:", id_token);
      
      // Pass ALL the crypto data to the onboarding flow!
      router.push({
        pathname: '/onboarding',
        params: {
          jwt: id_token,
          ephemeralSecret: ephemeralKey.getSecretKey(),
          maxEpoch: maxEpochState.toString(),
          randomness: randomnessState,
        }
      });
    }
  }, [response]);

  const handleStart = () => {
    if (nonce) {
      // Triggers the Google popup
      promptAsync();
    } else {
      console.log("Still generating cryptographic nonce, please wait...");
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <LinearGradient colors={['#0D0B10', '#1A1621']} style={StyleSheet.absoluteFillObject} />
      
      <View style={styles.container}>
        <View style={styles.logoContainer}>
          <Text style={styles.logoText}>Chaptr.</Text>
          <View style={styles.divider} />
          <Text style={styles.tagline}>The end of swiping.{"\n"}The start of a connection.</Text>
        </View>

        <TouchableOpacity 
          style={[styles.button, !nonce && { opacity: 0.7 }]} 
          onPress={handleStart} 
          activeOpacity={0.9}
          disabled={!nonce} // Prevent clicking before crypto is ready
        >
          <LinearGradient
            colors={['#D94A8C', '#7A3EB8']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.buttonGradient}
          >
            <Text style={styles.buttonText}>
              {nonce ? "Begin Your Next Chapter" : "Securing Connection..."}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
        
        <Text style={styles.footerText}>Powered by Sui zkLogin</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  container: { flex: 1, justifyContent: 'space-between', padding: 40, alignItems: 'center' },
  logoContainer: { marginTop: 100, alignItems: 'center' },
  logoText: { fontSize: 48, fontWeight: '700', color: '#FDFBF7', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif' },
  divider: { height: 1, width: 60, backgroundColor: '#D94A8C', marginVertical: 20 },
  tagline: { fontSize: 18, color: '#A299A8', textAlign: 'center', lineHeight: 28, fontStyle: 'italic' },
  button: { width: '100%', height: 60, borderRadius: 30, overflow: 'hidden', maxWidth: 400 },
  buttonGradient: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 1 },
  footerText: { color: '#4A424E', fontSize: 12, marginBottom: 20, letterSpacing: 1, textTransform: 'uppercase' }
});