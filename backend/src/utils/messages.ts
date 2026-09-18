/**
 * Client-safe error text.
 *
 * Internal messages can carry absolute filesystem paths (spawn failures,
 * tracebacks, temp dirs). Anything path-shaped is replaced before a message is
 * stored on a job, logged at startup, or returned to a client.
 */
export function safeMessage(message: string): string {
  return message.replace(/(\/[^\s:]+)+/g, '[path]').slice(0, 300);
}
