import { useSession } from "../features/auth/SessionProvider.js";

/**
 * Sign in.
 *
 * There is no username field and no password field, and that is not a
 * simplification — it is the design. The credential is discoverable, so the
 * security key names the account. Nothing on this page can be used to find out
 * whether a given person has an account.
 */
export function SignInScreen() {
  const session = useSession();

  return (
    <main className="signin">
      <h1>Printing Kiosk — Control Plane</h1>
      <p>Sign in with your registered security key.</p>

      <button type="button" className="signin__action" onClick={() => void session.signIn()}>
        Use security key
      </button>

      {session.error ? (
        <p role="alert" className="signin__error">
          {session.error}
        </p>
      ) : null}

      <p className="signin__note">
        Lost every key for your account? Recovery needs the sealed offline code and enrols a
        replacement — it does not sign you in.
      </p>
    </main>
  );
}
