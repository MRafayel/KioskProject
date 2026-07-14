import { Navigate, Route, Routes } from "react-router-dom";

import { KioskLayout } from "../components/KioskLayout.js";
import { SessionTimerProvider } from "../features/session/SessionTimerProvider.js";
import { CheckoutScreen } from "../routes/CheckoutScreen.js";
import { ConfigureScreen } from "../routes/ConfigureScreen.js";
import {
  CompleteScreen,
  FailureScreen,
  PaymentScreen,
  PrintingScreen
} from "../routes/StatusScreens.js";
import { UploadScreen } from "../routes/UploadScreen.js";
import { WelcomeScreen } from "../routes/WelcomeScreen.js";

export function App() {
  return (
    <SessionTimerProvider>
      <Routes>
        <Route path="/" element={<WelcomeScreen />} />
        <Route element={<KioskLayout />}>
          <Route path="/upload" element={<UploadScreen />} />
          <Route path="/configure" element={<ConfigureScreen />} />
          <Route path="/checkout" element={<CheckoutScreen />} />
          <Route path="/payment" element={<PaymentScreen />} />
          <Route path="/printing" element={<PrintingScreen />} />
          <Route path="/failure/:failureType" element={<FailureScreen />} />
          <Route path="/complete" element={<CompleteScreen />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionTimerProvider>
  );
}
