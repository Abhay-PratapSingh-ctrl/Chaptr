import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateNonce, generateRandomness } from '@mysten/sui/zklogin';

// For the Hackathon, you would replace this with your actual Google Client ID
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
const REDIRECT_URI = 'http://localhost:8081'; // Your Expo PWA local URL

export const setupZkLogin = () => {
  // 1. Generate a temporary "throwaway" keypair for this session
  const ephemeralKeyPair = new Ed25519Keypair();
  
  // 2. Define how long this session is valid (e.g., current epoch + 10)
  // In a real app, you fetch the current epoch from the Sui network
  const maxEpoch = 1000; 

  // 3. Generate randomness for the Zero-Knowledge proof
  const randomness = generateRandomness();

  // 4. Create the cryptographic nonce binding the key to the Google login
  const nonce = generateNonce(
    ephemeralKeyPair.getPublicKey(),
    maxEpoch,
    randomness
  );

  // 5. Construct the Google OAuth URL
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: REDIRECT_URI,
    scope: 'openid email profile',
    nonce: nonce,
  });

  const loginUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // We return the URL and the temporary data we need to verify the proof later
  return {
    loginUrl,
    ephemeralKeyPair,
    maxEpoch,
    randomness
  };
};