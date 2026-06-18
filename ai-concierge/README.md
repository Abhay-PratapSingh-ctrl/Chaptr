# Chaptr Mobile App (ai-concierge)

This is the React Native (Expo) frontend for the Chaptr protocol.

> **Note:** For the complete system architecture, on-chain mechanics, and AI engine details, please see the [Main Repository README](../README.md) and Architecture documentation.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables (copy `.env.example` to `.env` and fill in your keys):
   ```bash
   # Required for full functionality
   EXPO_PUBLIC_GOOGLE_CLIENT_ID=
   EXPO_PUBLIC_ENOKI_API_KEY=
   EXPO_PUBLIC_GEMINI_API_KEY=
   EXPO_PUBLIC_GROQ_API_KEY=
   ```

3. Start the development server (Web is recommended for the hackathon demo):
   ```bash
   npx expo start --web
   ```

## Folder Structure

- `app/`: Expo Router screens and navigation
- `components/`: Reusable UI components
- `constants/`: Theme and configuration constants
- `utils/`: Core protocol services (AI, Sui, Walrus, zkLogin, Memory)
- `assets/`: Images and fonts
