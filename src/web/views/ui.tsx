import type { Child } from "hono/jsx";

export function Csrf(props: { token: string }) {
  return <input type="hidden" name="_csrf" value={props.token} />;
}

interface FieldProps {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  optional?: boolean;
  class?: string;
  children: Child;
}

// Champ avec libellé, aide et erreur reliés par aria-describedby (voir describedBy).
export function Field(props: FieldProps) {
  return (
    <div class={props.class ? `field ${props.class}` : "field"}>
      <label class="label" for={props.id}>
        {props.label}
        {props.optional ? <span class="optional"> (facultatif)</span> : null}
      </label>
      {props.children}
      {props.hint ? (
        <p class="hint" id={`${props.id}-aide`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p class="field-error" id={`${props.id}-erreur`}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function describedBy(id: string, hasHint: boolean, error?: string): string | undefined {
  const ids = [hasHint ? `${id}-aide` : null, error ? `${id}-erreur` : null].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export function Notice(props: { kind?: "error" | "info"; title?: string; children?: Child }) {
  const error = props.kind === "error";
  return (
    <div class={error ? "notice notice--error" : "notice"} role={error ? "alert" : "status"}>
      {props.title ? (
        <p>
          <strong>{props.title}</strong>
        </p>
      ) : null}
      {props.children ? <p>{props.children}</p> : null}
    </div>
  );
}

export function Empty(props: { title: string; children?: Child; actions?: Child }) {
  return (
    <div class="empty">
      <strong>{props.title}</strong>
      {props.children ? <p>{props.children}</p> : null}
      {props.actions ? <div class="actions">{props.actions}</div> : null}
    </div>
  );
}

export function ChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

export function ChevronRight() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}
