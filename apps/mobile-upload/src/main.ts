// This entry intentionally has no imports. The QR bearer must be removed from
// the address bar before React, routing, error tracking, or any other module is
// evaluated. All application code is loaded dynamically after capture.

type InitialGrant =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "present"; token: string }>;

let capturedGrant = captureInitialGrant();

void import("./render.js")
  .then(({ mountMobileUpload }) => {
    const grantForApplication = capturedGrant;
    capturedGrant = { kind: "missing" };
    mountMobileUpload(grantForApplication);
  })
  .catch(() => showSafeLoadError());

function captureInitialGrant(): InitialGrant {
  const fragment = window.location.hash;
  if (fragment) {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }

  if (!fragment) return { kind: "missing" };

  const parameters = new URLSearchParams(fragment.slice(1));
  const tokens = parameters.getAll("t");
  const containsOnlyToken = [...parameters.keys()].every((key) => key === "t");
  const token = tokens[0];
  if (tokens.length !== 1 || !containsOnlyToken || !token || !/^u_[A-Za-z0-9_-]{43}$/.test(token)) {
    return { kind: "invalid" };
  }

  return { kind: "present", token };
}

function showSafeLoadError(): void {
  capturedGrant = { kind: "missing" };
  const root = document.getElementById("root");
  if (!root) return;

  const main = document.createElement("main");
  main.setAttribute("role", "alert");
  const heading = document.createElement("h1");
  heading.textContent = "Չհաջողվեց բացել տպման գործողությունը";
  const detail = document.createElement("p");
  detail.textContent = "Վերադարձեք տերմինալ և նորից սկանավորեք QR կոդը։";
  main.append(heading, detail);
  root.replaceChildren(main);
}
