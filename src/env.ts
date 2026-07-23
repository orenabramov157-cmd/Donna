// Bindings + vars come from the generated `Env` (worker-configuration.d.ts,
// produced by `npm run types`). Secrets are set in the dashboard, so wrangler
// cannot generate them — they are declared here, all optional so the code
// must handle their absence gracefully (surfaced on /setup).

export interface Secrets {
  LOOP_AUTH_KEY?: string;
  LOOP_WEBHOOK_AUTH?: string;
  OWNER_CONTACT?: string;
  TRELLO_KEY?: string;
  TRELLO_TOKEN?: string;
  TRELLO_BOARD_ID?: string;
  SETUP_KEY?: string;
  WEBHOOK_TOKEN?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM?: string;
}

// `wrangler types` narrows vars to the literal values in wrangler.jsonc, but
// every var is dashboard-editable at runtime — widen them back to string.
type WidenVars = { [K in keyof Env]: Env[K] extends string ? string : Env[K] };

export type AppEnv = WidenVars & Secrets;
