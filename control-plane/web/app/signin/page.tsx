"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

/** The dev provider's form is rendered only when the server put it in the
 * providers list; `NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH` mirrors that flag for the
 * browser half. Google gets a plain button, and pressing it when no client is
 * configured is a 404 from Auth.js rather than a half-working form. */
export default function SignIn() {
  const [email, setEmail] = useState("");
  const devAuth = process.env.NEXT_PUBLIC_CONTROL_PLANE_DEV_AUTH === "1";

  return (
    <main>
      <h1>Sign in</h1>
      <div className="card card-narrow">
        <button
          className="btn-primary"
          type="button"
          onClick={() => void signIn("google")}
        >
          Continue with Google
        </button>
      </div>
      {devAuth && (
        <form
          className="form card card-narrow"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn("dev", { email, callbackUrl: "/" });
          }}
        >
          <h2>Developer sign-in</h2>
          <label>
            Email{" "}
            <input
              name="email"
              type="email"
              data-testid="dev-email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>{" "}
          <button
            className="btn-primary"
            type="submit"
            data-testid="dev-submit"
          >
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}
