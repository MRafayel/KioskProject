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
import { KioskRedirect, KioskRouterProvider, useKioskLocation } from "./router.js";

export function App({ initialPath }: { initialPath?: string }) {
  return (
    <KioskRouterProvider {...(initialPath === undefined ? {} : { initialPath })}>
      <SessionTimerProvider>
        <KioskRoutes />
      </SessionTimerProvider>
    </KioskRouterProvider>
  );
}

function KioskRoutes() {
  const { pathname } = useKioskLocation();
  if (pathname === "/") return <WelcomeScreen />;

  const screen =
    pathname === "/upload" ? (
      <UploadScreen />
    ) : pathname === "/configure" ? (
      <ConfigureScreen />
    ) : pathname === "/checkout" ? (
      <CheckoutScreen />
    ) : pathname === "/payment" ? (
      <PaymentScreen />
    ) : pathname === "/printing" ? (
      <PrintingScreen />
    ) : pathname === "/failure/payment" || pathname === "/failure/printer" ? (
      <FailureScreen failureType={pathname.endsWith("/payment") ? "payment" : "printer"} />
    ) : pathname === "/complete" ? (
      <CompleteScreen />
    ) : null;

  return screen ? <KioskLayout>{screen}</KioskLayout> : <KioskRedirect to="/" />;
}
