import React from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';

import AppProvider from '@/context/AppProvider.jsx';
import AppRouter from '@/router/AppRouter.jsx';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

export default function RobotXApp() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AppProvider>
        <AppRouter />
      </AppProvider>
    </GoogleOAuthProvider>
  );
}
