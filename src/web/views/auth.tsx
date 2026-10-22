import { type PageMeta, PublicPage } from "./layout.js";
import { Csrf, Field, Notice } from "./ui.js";

export function LoginPage(props: { meta: PageMeta; error?: string | undefined; mock: boolean }) {
  const name = props.meta.settings.displayName;
  return (
    <PublicPage {...props.meta}>
      <div class="narrow">
        <div class="narrow-box">
          <div>
            {name ? <p class="muted">{name}</p> : null}
            <h1>Administration</h1>
          </div>
          <p class="muted">Accès réservé aux adresses autorisées.</p>
          {props.error ? <Notice kind="error" title="Connexion impossible">{props.error}</Notice> : null}
          <a class="btn btn--primary btn--block" href="/auth/google/connexion">
            Se connecter avec Google
          </a>
          {props.mock ? <p class="hint">Mode simulé : aucune requête n'est envoyée à Google.</p> : null}
        </div>
      </div>
    </PublicPage>
  );
}

export function MockConsentPage(props: {
  meta: PageMeta;
  purpose: "login" | "connect";
  state: string;
  challenge: string;
  email: string;
  error?: string;
}) {
  return (
    <PublicPage {...props.meta}>
      <div class="narrow">
        <form class="narrow-box" method="post" action="/auth/mock/authorize">
          <div>
            <p class="mock-badge">Fournisseur simulé</p>
            <h1>{props.purpose === "login" ? "Connexion" : "Connecter un compte d'agenda"}</h1>
          </div>
          <p class="muted">
            {props.purpose === "login"
              ? "Remplace l'écran de connexion Google. Indiquez l'adresse du compte."
              : "Remplace l'écran d'autorisation Google. Le compte simulé expose un agenda personnel, un agenda partagé et un agenda en lecture seule. Une adresse commençant par « revoque » simule une autorisation révoquée."}
          </p>
          <Csrf token={props.meta.csrf} />
          <input type="hidden" name="state" value={props.state} />
          <input type="hidden" name="code_challenge" value={props.challenge} />
          <input type="hidden" name="purpose" value={props.purpose} />
          <Field id="email" label="Adresse du compte" error={props.error}>
            <input class="input" id="email" name="email" type="email" required value={props.email} autocomplete="email" />
          </Field>
          <div class="actions">
            <button class="btn btn--primary" type="submit" name="decision" value="autoriser">
              Autoriser
            </button>
            <button class="btn" type="submit" name="decision" value="refuser">
              Refuser
            </button>
          </div>
        </form>
      </div>
    </PublicPage>
  );
}
