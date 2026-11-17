import { useEffect, useState } from "react";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { apiFetch, API_URL } from "@/lib/api";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import type { User } from "@shared/types";

// This completes the auth session - required for expo-auth-session to work
WebBrowser.maybeCompleteAuthSession();

interface UseGoogleAuthResult {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const TOKEN_KEY = "rt_token";
const USER_KEY = "rt_user";

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID ?? "your-google-client-id.apps.googleusercontent.com";

// For expo-auth-session with Google, we use the authorization code flow with PKCE
// and then exchange the code for tokens, or we can use the implicit flow for ID token
// The backend expects an ID token (credential), so we'll use the implicit flow

// Discovery document for Google
const discovery = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
};

const scopes = ["openid", "email", "profile"];

const redirectUri = AuthSession.makeRedirectUri({
  scheme: "ramachandra",
  native: "ramachandra://oauth2redirect",
});

export function useGoogleAuth(): UseGoogleAuthResult {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Load user from secure storage on mount
  useEffect(() => {
    const loadUser = async () => {
      try {
        const storedUser = await SecureStore.getItemAsync(USER_KEY);
        if (storedUser) {
          setUser(JSON.parse(storedUser));
        }
      } catch {
        // Ignore storage errors
      } finally {
        setLoading(false);
      }
    };
    loadUser();
  }, []);

  // Use the implicit flow to get an ID token directly
  // This is the flow that gives us the ID token the backend expects
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes,
      redirectUri,
      usePKCE: false, // Disable PKCE for implicit flow to get ID token
      responseType: AuthSession.ResponseType.IdToken,
      extraParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
    discovery
  );

  // Handle the auth response
  useEffect(() => {
    if (response?.type === "success") {
      const { id_token } = response.params;
      if (id_token) {
        exchangeIdTokenForSession(id_token);
      }
    } else if (response?.type === "error") {
      console.error("[GoogleAuth] Auth error:", response.error);
    }
  }, [response]);

  const exchangeIdTokenForSession = async (idToken: string) => {
    try {
      // Send the ID token to the backend (the backend calls this field 'credential')
      const data = await apiFetch<{ user: User; token: string }>("/api/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential: idToken }),
      });

      if (data.user && data.token) {
        setUser(data.user);
        await SecureStore.setItemAsync(USER_KEY, JSON.stringify(data.user));
        await SecureStore.setItemAsync(TOKEN_KEY, data.token);
      }
    } catch (e) {
      console.error("[GoogleAuth] ID token exchange failed:", e);
      throw e;
    }
  };

  const signIn = async () => {
    if (!request) {
      console.warn("[GoogleAuth] Request not ready");
      return;
    }
    const result = await promptAsync();
    // The response is handled by the useEffect above
  };

  const signOut = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Ignore logout errors
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
    setUser(null);
  };

  const refreshUser = async () => {
    try {
      const data = await apiFetch<User>("/api/auth/me");
      setUser(data);
      await SecureStore.setItemAsync(USER_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("[GoogleAuth] Refresh failed:", e);
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(USER_KEY);
      setUser(null);
    }
  };

  return { user, loading, signIn, signOut, refreshUser };
}