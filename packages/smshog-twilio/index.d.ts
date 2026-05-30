/**
 * smshog-twilio — TypeScript definitions
 */

export interface PatchOptions {
  /** SMSHog base URL. Default: process.env.SMSHOG_URL ?? 'http://localhost:9090' */
  url?: string;
  /** Log intercepted messages to stdout. Default: true */
  verbose?: boolean;
}

export interface SmshogClientOptions {
  /** SMSHog base URL. Default: process.env.SMSHOG_URL ?? 'http://localhost:9090' */
  url?: string;
  /** Fake account SID to embed in the API path. Default: 'ACsmshog' */
  sid?: string;
  /** Log sent messages to stdout. Default: true */
  verbose?: boolean;
}

export interface MessageCreateParams {
  to: string;
  from?: string;
  body: string;
  mediaUrl?: string;
  statusCallback?: string;
  [key: string]: unknown;
}

export interface MessageResult {
  sid: string;
  to: string;
  from: string;
  body: string;
  status: string;
  dateCreated: Date;
  dateUpdated: Date;
  uri: string;
  fetch(): Promise<MessageResult>;
  update(params?: Partial<MessageCreateParams>): Promise<MessageResult>;
  remove(): Promise<boolean>;
}

export interface SmshogClient {
  accountSid: string;
  messages: {
    create(params: MessageCreateParams): Promise<MessageResult>;
  };
}

/**
 * Patches an existing Twilio client so all `client.messages.create()` calls
 * are intercepted and sent to SMSHog instead of the real Twilio API.
 *
 * @example
 * ```ts
 * import twilio from 'twilio';
 * import { patchTwilio } from 'smshog-twilio';
 *
 * const client = twilio(process.env.TWILIO_SID!, process.env.TWILIO_TOKEN!);
 * if (process.env.NODE_ENV !== 'production') patchTwilio(client);
 *
 * await client.messages.create({ to: '+1...', from: '+1...', body: 'Hello' });
 * ```
 */
export function patchTwilio(client: object, opts?: PatchOptions): object;

/**
 * Restores the original Twilio `messages.create` method on a previously patched client.
 */
export function unpatchTwilio(client: object): void;

/**
 * Creates a lightweight fake Twilio-shaped client that routes all messages to SMSHog.
 * Useful in CI where real Twilio credentials aren't available.
 *
 * @example
 * ```ts
 * import { createSmshogClient } from 'smshog-twilio';
 *
 * const client = createSmshogClient();
 * await client.messages.create({ to: '+1...', from: '+1...', body: 'Hello CI' });
 * ```
 */
export function createSmshogClient(opts?: SmshogClientOptions): SmshogClient;
